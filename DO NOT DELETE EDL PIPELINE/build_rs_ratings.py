"""Build current, reproducible cross-sectional relative-strength ratings."""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

import pandas as pd

from pipeline_utils import BASE_DIR, save_json


FRONT_WEIGHTED_HORIZONS = {
    "one_month": 21,
    "three_month": 63,
    "six_month": 126,
    "twelve_month": 252,
}
FRONT_WEIGHTED_WEIGHTS = {
    "one_month": 0.40,
    "three_month": 0.20,
    "six_month": 0.20,
    "twelve_month": 0.20,
}
MINIMUM_ALIGNED_SESSIONS = 260
FRONT_WEIGHTED_BENCHMARK_FILENAME = "NIFTY_500.csv"


def liquid_universe(root):
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


def close_history(path):
    frame = pd.read_csv(path)
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
    frame["Close"] = pd.to_numeric(frame["Close"], errors="coerce")
    return frame.dropna(subset=("Date", "Close")).sort_values("Date").drop_duplicates("Date", keep="last")


def relative_strength_scores(stock, benchmark, as_of_date):
    """Return the four date-aligned Nifty 500-relative horizon scores.

    A rating is only valid when all four horizon endpoints are aligned to the
    benchmark's current completed session.  This prevents a stale stock file
    from receiving a rating labelled with a newer market date.
    """
    merged = stock[["Date", "Close"]].merge(
        benchmark[["Date", "Close"]], on="Date", suffixes=("_stock", "_benchmark")
    )
    if len(merged) < MINIMUM_ALIGNED_SESSIONS:
        return None
    if merged["Date"].iloc[-1].date() != as_of_date:
        return None

    relative_ratios = {}
    for name, horizon in FRONT_WEIGHTED_HORIZONS.items():
        start, end = merged.iloc[-1 - horizon], merged.iloc[-1]
        if any(not math.isfinite(value) or value <= 0 for value in
               (start.Close_stock, end.Close_stock, start.Close_benchmark, end.Close_benchmark)):
            return None
        stock_ratio = end.Close_stock / start.Close_stock
        benchmark_ratio = end.Close_benchmark / start.Close_benchmark
        relative_ratios[name] = stock_ratio / benchmark_ratio

    return relative_ratios if all(math.isfinite(value) for value in relative_ratios.values()) else None


def strictly_lower_counts(scores):
    """Integer counts underlying the fractional momentum period ranks."""
    values = pd.Series(scores, dtype=float)
    if values.empty:
        return {}
    return (values.rank(method="min") - 1).astype(int).to_dict()


def rank_first_ratings(scores):
    """Rank each horizon on one complete universe, weight its ranks, rank again."""
    symbols = set.intersection(*(set(scores.get(key, {})) for key in FRONT_WEIGHTED_HORIZONS))
    symbols = sorted(symbol for symbol in symbols if all(
        math.isfinite(scores[key][symbol]) and scores[key][symbol] > 0 for key in FRONT_WEIGHTED_HORIZONS))
    lower_counts = {key: strictly_lower_counts({symbol: scores[key][symbol] for symbol in symbols})
              for key in FRONT_WEIGHTED_HORIZONS}
    ranked = {key: {symbol: 1 + 98 * count / max(1, len(symbols) - 1)
                    for symbol, count in counts.items()} for key, counts in lower_counts.items()}
    # The additive constant and positive common denominator do not affect order.
    # Sort exact integer weighted counts to avoid float noise breaking real ties.
    composite = {symbol: sum(round(weight * 100) * lower_counts[key][symbol]
                             for key, weight in FRONT_WEIGHTED_WEIGHTS.items()) for symbol in symbols}
    # Stable symbol order makes equal composites reproducible. The reference
    # assigns ordinal final ratings (not equal ratings to tied composites).
    ordered = sorted(symbols, key=lambda symbol: (-composite[symbol], symbol))
    ranked = {key: {symbol: math.floor(value + 0.5) for symbol, value in values.items()}
              for key, values in ranked.items()}
    ranked['front_weighted'] = {
        symbol: math.floor(99 - 98 * position / max(1, len(ordered) - 1) + 0.5)
        for position, symbol in enumerate(ordered)
    }
    return ranked


def main():
    root = Path(BASE_DIR)
    front_weighted_benchmark_path = root / "indices_ohlcv_data" / FRONT_WEIGHTED_BENCHMARK_FILENAME
    if not front_weighted_benchmark_path.exists():
        print(f"Error: {FRONT_WEIGHTED_BENCHMARK_FILENAME} benchmark history is missing.")
        return False
    front_weighted_benchmark = close_history(front_weighted_benchmark_path)
    if front_weighted_benchmark.empty:
        print(f"Error: {FRONT_WEIGHTED_BENCHMARK_FILENAME} contains no valid closes.")
        return False
    as_of_date = front_weighted_benchmark["Date"].iloc[-1].date()
    eligible, universe_generated_at = liquid_universe(root)
    scores = {rating_key: {} for rating_key in FRONT_WEIGHTED_HORIZONS}
    for path in sorted((root / "ohlcv_data").glob("*.csv")):
        if path.stem.upper() not in eligible:
            continue
        stock = close_history(path)
        relative_scores = relative_strength_scores(stock, front_weighted_benchmark, as_of_date)
        if relative_scores is not None:
            for rating_key, score in relative_scores.items():
                scores[rating_key][path.stem] = score

    ranked = rank_first_ratings(scores)
    ratings = {
        symbol: {rating_key: values[symbol] for rating_key, values in ranked.items()}
        for symbol in ranked["front_weighted"]
    }
    if not ratings:
        print("Error: no breadth-eligible symbols have 260 aligned NIFTY 500 sessions.")
        return False

    as_of = as_of_date.isoformat()
    save_json(root / "rs_rating_daily.json", {
        "source": "locally computed cross-sectional relative-strength percentiles",
        "as_of_date": as_of,
        "universe": "breadth_eligible",
        "universe_generated_at": universe_generated_at,
        "liquid_universe_count": len(ratings),
        "methodology": {
            "version": "nexus_rank_first_v3",
            "benchmark": "NIFTY 500",
            "benchmark_file": FRONT_WEIGHTED_BENCHMARK_FILENAME,
            "windows": FRONT_WEIGHTED_HORIZONS,
            "weights": FRONT_WEIGHTED_WEIGHTS,
            "minimum_aligned_sessions": MINIMUM_ALIGNED_SESSIONS,
            "rating_keys": ["one_month", "three_month", "six_month", "twelve_month", "front_weighted"],
            "score_formula": "sum(weight_horizon * unrounded_horizon_percentile_rank)",
            "horizon_score_formula": "stock_horizon_price_ratio / nifty_500_horizon_price_ratio",
            "horizon_rank_formula": "1 + 98 * strictly_lower_scores / max(1, eligible_scores - 1)",
            "rank_formula": "floor(99 - 98 * descending_position / max(1, eligible_scores - 1) + 0.5)",
            "composite_ties": "stable symbol ascending order",
            "composite_ordering": "exact integer weighted strictly-lower counts",
            "horizon_rating_rounding": "floor(unrounded_horizon_percentile_rank + 0.5)",
        },
        "ratings": ratings,
    }, ensure_ascii=False)
    print(
        f"Saved front-weighted Nifty 500 RS ratings for {len(ratings)} symbols as of {as_of}."
    )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
