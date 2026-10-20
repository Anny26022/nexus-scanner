"""Build current, reproducible cross-sectional relative-strength ratings matching official MarketStrength methodology."""

from __future__ import annotations

from collections import Counter
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

MINIMUM_SESSIONS = 126
FRONT_WEIGHTED_BENCHMARK_FILENAME = "NIFTY_500.csv"


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

    composite_scores_today: dict[str, float] = {}
    composite_scores_21d_ago: dict[str, float] = {}
    period_scores: dict[str, dict[str, float]] = {k: {} for k in HORIZONS}
    rs_line_high_flags: dict[str, bool] = {}

    for path in sorted(ohlcv_dir.glob("*.csv")):
        sym = path.stem.upper()
        if sym not in eligible:
            continue

        stock = close_history(path)
        if stock.empty:
            continue

        # Trim stock up to as_of_date
        stock = stock[stock["Date"].dt.date <= as_of_date]
        if stock.empty or stock["Date"].iloc[-1].date() != as_of_date:
            continue

        closes = stock["Close"].tolist()

        # Compute today's returns & composite
        ret_today = compute_stock_returns(closes, offset=0)
        if ret_today is not None:
            comp_today = calculate_composite_score(ret_today)
            if comp_today is not None:
                composite_scores_today[sym] = comp_today
                for k in HORIZONS:
                    if k in ret_today:
                        period_scores[k][sym] = ret_today[k]

        # Compute 21-day ago returns & composite (for RS momentum delta)
        ret_21d = compute_stock_returns(closes, offset=21)
        if ret_21d is not None:
            comp_21d = calculate_composite_score(ret_21d)
            if comp_21d is not None:
                composite_scores_21d_ago[sym] = comp_21d

        # Check RS line 52W high
        rs_line_high_flags[sym] = check_rs_line_52w_high(stock, benchmark)

    # Compute percentiles across the base universe
    ranked_today = percentile_rank(composite_scores_today)
    ranked_21d = percentile_rank(composite_scores_21d_ago)
    ranked_periods = {k: percentile_rank(scores) for k, scores in period_scores.items()}

    ratings: dict[str, dict] = {}
    for sym, comp_rank in ranked_today.items():
        prev_rank = ranked_21d.get(sym)
        delta_21d = (comp_rank - prev_rank) if prev_rank is not None else None

        ratings[sym] = {
            "front_weighted": comp_rank,  # backward compatibility alias for frontend
            "composite_rs": comp_rank,
            "one_month": ranked_periods["one_month"].get(sym),
            "three_month": ranked_periods["three_month"].get(sym),
            "six_month": ranked_periods["six_month"].get(sym),
            "nine_month": ranked_periods["nine_month"].get(sym),
            "twelve_month": ranked_periods["twelve_month"].get(sym),
            "rs_change_21d": delta_21d,
            "is_rs_line_52w_high": rs_line_high_flags.get(sym, False),
        }

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
            "version": "marketstrength_parity_v1",
            "benchmark": "NIFTY 500",
            "benchmark_file": FRONT_WEIGHTED_BENCHMARK_FILENAME,
            "windows": HORIZONS,
            "weights": WEIGHTS,
            "minimum_aligned_sessions": MINIMUM_SESSIONS,
            "rating_keys": ["one_month", "three_month", "six_month", "nine_month", "twelve_month", "front_weighted"],
            "score_formula": "0.40*R63 + 0.20*R126 + 0.20*R189 + 0.20*R252",
            "rank_formula": "floor(1 + 98 * strictly_lower_scores / max(1, eligible_scores - 1) + 0.5)",
            "momentum_delta": "today_composite_rs - rs_21_sessions_ago",
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
