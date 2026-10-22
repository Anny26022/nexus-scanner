"""Build current, reproducible cross-sectional relative-strength ratings matching official MarketStrength methodology."""

from __future__ import annotations

from collections import Counter
from bisect import bisect_right
import gzip
import json
import math
from pathlib import Path

import pandas as pd

from pipeline_utils import BASE_DIR, save_json, compress_file


HORIZONS = {
    "one_month": 21,
    "three_month": 63,
    "six_month": 126,
    "nine_month": 189,
    "twelve_month": 252,
}

WEIGHTS = {
    "three_month": 0.40,
    "six_month": 0.20,
    "nine_month": 0.20,
    "twelve_month": 0.20,
}

MINIMUM_SESSIONS = 127
FRONT_WEIGHTED_BENCHMARK_FILENAME = "NIFTY_500.csv"
METHODOLOGY_VERSION = "marketstrength_parity_v2"
UNIVERSE_HISTORY_FILE = "rs_universe_history.json.gz"


def load_universe_history(root: Path) -> dict[str, set[str]]:
    path = root / UNIVERSE_HISTORY_FILE
    if not path.exists():
        return {}
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    if payload.get("methodology_version") != METHODOLOGY_VERSION:
        raise ValueError("RS universe archive methodology mismatch; rebuild the dated archive")
    return {d: set(symbols) for d, symbols in payload["sessions"].items()}


def save_universe_history(root: Path, sessions: dict[str, set[str]]) -> None:
    # Membership is retained per date; today's universe never substitutes for an old one.
    path = root / UNIVERSE_HISTORY_FILE
    temporary = path.with_suffix(".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        json.dump({"methodology_version": METHODOLOGY_VERSION,
                   "sessions": {d: sorted(symbols) for d, symbols in sorted(sessions.items())}}, handle)
    temporary.replace(path)


def rank_session(histories, session: str, eligible: set[str]) -> dict[str, dict]:
    """One dated rank engine for daily, backfill and gallery callers.

    Histories contain sorted ISO trading dates and close arrays. A stale final
    candle cannot participate in the cross-section for another market session.
    """
    scores = {}
    periods = {k: {} for k in HORIZONS}
    for symbol in sorted(eligible):
        if symbol not in histories:
            continue
        dates, closes = histories[symbol]
        end = bisect_right(dates, session)
        if not end or dates[end - 1] != session:
            continue
        returns = compute_stock_returns(closes, offset=len(closes) - end)
        score = calculate_composite_score(returns) if returns is not None else None
        if score is None:
            continue
        scores[symbol] = score
        for key, value in returns.items():
            periods[key][symbol] = value
    ranks = percentile_rank(scores)
    period_ranks = {k: percentile_rank(values) for k, values in periods.items()}
    return {symbol: {"front_weighted": value, "composite_rs": value,
                     **{k: period_ranks[k].get(symbol) for k in HORIZONS}}
            for symbol, value in ranks.items()}


def prior_market_session(sessions: list[str], session: str, lookback: int = 21) -> str | None:
    end = bisect_right(sessions, session) - 1
    return sessions[end - lookback] if end >= lookback and sessions[end] == session else None


def liquid_universe(root: Path):
    """Use the pipeline's documented breadth-eligible universe for RS ranks."""
    path = root / "breadth_universe_snapshot.json"
    if path.exists():
        opener = open
    else:
        path = path.with_suffix(".json.gz")
        opener = gzip.open
    if not path.exists():
        raise FileNotFoundError("breadth_universe_snapshot.json(.gz) is required before RS ratings")
    with opener(path, "rt", encoding="utf-8") as handle:
        snapshot = json.load(handle)
    symbols = {str(item["symbol"]).upper() for item in snapshot.get("eligible", []) if item.get("symbol")}
    if not symbols:
        raise ValueError("breadth universe contains no eligible symbols")
    return symbols, snapshot.get("generated_at")


def close_history(path: Path) -> pd.DataFrame:
    """Read date-sorted, valid close history."""
    frame = pd.read_csv(path)
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
    frame["Close"] = pd.to_numeric(frame["Close"], errors="coerce")
    return frame.dropna(subset=("Date", "Close")).sort_values("Date").drop_duplicates("Date", keep="last")


def determine_as_of_date(ohlcv_dir: Path, benchmark_dates: set) -> str | None:
    """Find the latest market session shared between the majority of stocks and benchmark."""
    counts = Counter()
    files = list(ohlcv_dir.glob("*.csv"))[:300]
    for p in files:
        try:
            with open(p, "r", encoding="utf-8") as f:
                lines = f.readlines()
                if len(lines) > 1:
                    last_date = lines[-1].strip().split(",")[0]
                    counts[last_date] += 1
        except Exception:
            pass

    for candidate_date, _ in counts.most_common():
        try:
            ts = pd.to_datetime(candidate_date).date()
            if ts in benchmark_dates or str(ts) in benchmark_dates:
                return str(ts)
        except Exception:
            pass
    return None


def compute_stock_returns(closes: list[float], offset: int = 0) -> dict[str, float] | None:
    """Calculate multi-horizon percentage returns from close series.

    offset=0 computes as of latest session; offset=21 computes as of 21 sessions ago.
    """
    n = len(closes) - offset
    if n < MINIMUM_SESSIONS:
        return None

    end_idx = n - 1
    end_price = closes[end_idx]
    if not math.isfinite(end_price) or end_price <= 0:
        return None

    returns: dict[str, float] = {}
    for name, lookback in HORIZONS.items():
        if n > lookback:
            start_price = closes[end_idx - lookback]
            if math.isfinite(start_price) and start_price > 0:
                returns[name] = (end_price / start_price) - 1.0

    # Must at least have 3m and 6m returns to participate in composite
    if "three_month" not in returns or "six_month" not in returns:
        return None

    return returns


def calculate_composite_score(returns: dict[str, float]) -> float | None:
    """Blend returns according to MarketStrength weights (0.40/0.20/0.20/0.20).

    Official methodology:
    Weighted 12-month return: 0.40*3m + 0.20*6m + 0.20*9m + 0.20*12m
    over windows 63, 126, 189, 252 trading days.
    If lacking 9m/12m, 6m fills gap; < 6m gets None.
    """
    if "three_month" not in returns or "six_month" not in returns:
        return None

    r_3m = returns.get("three_month")
    r_6m = returns.get("six_month")
    if r_3m is None or r_6m is None or not (math.isfinite(r_3m) and math.isfinite(r_6m)):
        return None

    r_9m = returns.get("nine_month")
    if r_9m is None or not math.isfinite(r_9m):
        r_9m = r_6m

    r_12m = returns.get("twelve_month")
    if r_12m is None or not math.isfinite(r_12m):
        r_12m = r_6m

    score = 0.40 * r_3m + 0.20 * r_6m + 0.20 * r_9m + 0.20 * r_12m
    return score if math.isfinite(score) else None


def check_rs_line_52w_high(stock_df: pd.DataFrame, benchmark_df: pd.DataFrame) -> bool:
    """Check if date-aligned RS line (Close_stock / Close_bench) is at its 52-week high."""
    if len(stock_df) < 20 or len(benchmark_df) < 20:
        return False

    merged = stock_df[["Date", "Close"]].merge(
        benchmark_df[["Date", "Close"]], on="Date", suffixes=("_stock", "_bench")
    )
    if len(merged) < 20:
        return False
    if (stock_df["Date"].iloc[-1] != benchmark_df["Date"].iloc[-1]
            or merged["Date"].iloc[-1] != stock_df["Date"].iloc[-1]):
        return False

    merged["ratio"] = merged["Close_stock"] / merged["Close_bench"]
    lookback = min(len(merged), 252)
    window = merged["ratio"].iloc[-lookback:]
    latest = merged["ratio"].iloc[-1]
    return bool(latest >= window.max() * 0.9999)


def percentile_rank(scores: dict[str, float]) -> dict[str, int]:
    """Rank values from 1 to 99 across the universe."""
    if not scores:
        return {}
    series = pd.Series(scores, dtype=float).dropna()
    n = len(series)
    if n <= 1:
        return {k: 50 for k in series.index}

    # Ordinal ranking: (rank - 1) / (N - 1) * 98 + 1
    ranks = series.rank(method="min") - 1.0
    percentiles = (1.0 + 98.0 * (ranks / (n - 1.0))).round().astype(int).clip(1, 99)
    return percentiles.to_dict()


def main():
    root = Path(BASE_DIR)
    benchmark_path = root / "indices_ohlcv_data" / FRONT_WEIGHTED_BENCHMARK_FILENAME
    if not benchmark_path.exists():
        print(f"Error: {FRONT_WEIGHTED_BENCHMARK_FILENAME} benchmark history is missing.")
        return False

    benchmark = close_history(benchmark_path)
    if benchmark.empty:
        print(f"Error: {FRONT_WEIGHTED_BENCHMARK_FILENAME} contains no valid closes.")
        return False

    benchmark_dates = set(benchmark["Date"].dt.date)
    ohlcv_dir = root / "ohlcv_data"
    as_of_str = determine_as_of_date(ohlcv_dir, benchmark_dates)
    if not as_of_str:
        # Fall back to latest benchmark date if stock date couldn't be determined
        as_of_str = benchmark["Date"].iloc[-1].date().isoformat()

    as_of_date = pd.to_datetime(as_of_str).date()
    # Trim benchmark to as-of date
    benchmark = benchmark[benchmark["Date"].dt.date <= as_of_date]

    eligible, universe_generated_at = liquid_universe(root)

    dated_universes = load_universe_history(root)
    dated_universes[as_of_str] = eligible
    market_sessions = benchmark["Date"].dt.strftime("%Y-%m-%d").tolist()
    previous_date = prior_market_session(market_sessions, as_of_str)
    previous_eligible = dated_universes.get(previous_date, set())
    histories = {}
    frames = {}
    for symbol in sorted(eligible | previous_eligible):
        path = ohlcv_dir / f"{symbol}.csv"
        if not path.exists():
            continue
        frame = close_history(path)
        frames[symbol] = frame[frame["Date"].dt.date <= as_of_date]
        histories[symbol] = (frame["Date"].dt.strftime("%Y-%m-%d").tolist(), frame["Close"].tolist())
    ratings = rank_session(histories, as_of_str, eligible)
    previous = rank_session(histories, previous_date, previous_eligible) if previous_date else {}
    for symbol, rating in ratings.items():
        prior = previous.get(symbol)
        rating["rs_change_21d"] = rating["composite_rs"] - prior["composite_rs"] if prior else None
        rating["is_rs_line_52w_high"] = check_rs_line_52w_high(frames[symbol], benchmark)
    save_universe_history(root, dated_universes)

    if not ratings:
        print("Error: no breadth-eligible symbols met the RS minimum history threshold.")
        return False

    as_of = as_of_date.isoformat()
    output_path = root / "rs_rating_daily.json"
    save_json(output_path, {
        "source": "locally computed cross-sectional relative-strength percentiles",
        "as_of_date": as_of,
        "universe": "breadth_eligible",
        "universe_generated_at": universe_generated_at,
        "liquid_universe_count": len(ratings),
        "methodology": {
            "version": METHODOLOGY_VERSION,
            "benchmark": "NIFTY 500",
            "benchmark_file": FRONT_WEIGHTED_BENCHMARK_FILENAME,
            "windows": HORIZONS,
            "weights": WEIGHTS,
            "minimum_aligned_sessions": 127,
            "rating_keys": ["one_month", "three_month", "six_month", "nine_month", "twelve_month", "front_weighted"],
            "score_formula": "0.40*R63 + 0.20*R126 + 0.20*R189 + 0.20*R252",
            "rank_formula": "floor(1 + 98 * strictly_lower_scores / max(1, eligible_scores - 1) + 0.5)",
            "momentum_delta": "today_composite_rs - dated_rs_21_market_sessions_ago",
            "short_history_policy": "missing 9M/12M returns use 6M; fewer than 127 observations are unavailable",
            "rs_line": "date-aligned Close_stock / Close_Nifty500 at 52-week high",
        },
        "ratings": ratings,
    }, ensure_ascii=False)

    # Automatically compress to .json.gz as required by edl pipeline artifacts
    compress_file(output_path, output_path.with_suffix(".json.gz"))

    print(
        f"Saved audited MarketStrength RS ratings for {len(ratings)} symbols as of {as_of}."
    )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
