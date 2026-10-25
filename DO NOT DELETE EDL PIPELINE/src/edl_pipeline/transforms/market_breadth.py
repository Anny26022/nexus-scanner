"""Build sector and industry breadth without unreliable relative-strength ranks."""

import os
import re

import pandas as pd

from pipeline_utils import BASE_DIR, load_json, save_json


INPUT_FILE = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json")
SECTOR_OUTPUT_FILE = os.path.join(BASE_DIR, "sector_analytics.json")


def status_is_above(value, period):
    if not isinstance(value, str):
        return False
    match = re.search(rf"(?:^|\|)\s*SMA {period}:\s*(Above|Below)", value)
    return bool(match and match.group(1) == "Above")


def prepare_breadth_frame(stocks):
    frame = pd.DataFrame(stocks)
    if frame.empty:
        return frame

    close_source = frame["close"] if "close" in frame else frame.get("Stock Price(₹)")
    close = pd.to_numeric(close_source, errors="coerce")
    for period in (20, 50, 200):
        sma_source = (
            frame[f"sma{period}"]
            if f"sma{period}" in frame
            else pd.Series(index=frame.index, dtype=float)
        )
        sma = pd.to_numeric(sma_source, errors="coerce")
        direct = close.notna() & sma.notna()
        fallback = frame.get("SMA Status", pd.Series(index=frame.index, dtype=object)).apply(
            lambda value: status_is_above(value, period)
        )
        frame[f"above_sma{period}"] = (close > sma).where(direct, fallback).fillna(False)

    distance = pd.to_numeric(frame.get("% from 52W High"), errors="coerce").abs()
    frame["distance_from_52w_high_percent"] = distance
    return frame


def group_metrics(group):
    distance = group["distance_from_52w_high_percent"]
    return {
        "stock_count": int(len(group)),
        "above_sma20_percent": round(group["above_sma20"].mean() * 100, 1),
        "above_sma50_percent": round(group["above_sma50"].mean() * 100, 1),
        "above_sma200_percent": round(group["above_sma200"].mean() * 100, 1),
        "near_52w_high_1_percent": round((distance <= 1).mean() * 100, 1),
        "near_52w_high_2_percent": round((distance <= 2).mean() * 100, 1),
        "near_52w_high_5_percent": round((distance <= 5).mean() * 100, 1),
    }


def generate_analytics(stocks):
    frame = prepare_breadth_frame(stocks)
    if frame.empty:
        return {"sectors": [], "industries": []}

    sectors = []
    for name, group in frame.groupby("Sector", dropna=True):
        if name and name != "N/A":
            sectors.append({"name": name, **group_metrics(group)})

    industries = []
    for name, group in frame.groupby("Basic Industry", dropna=True):
        if name and name != "N/A":
            industries.append({
                "name": name,
                "sector": group["Sector"].iloc[0] if group["Sector"].nunique() == 1 else None,
                "sectors": sorted(group["Sector"].dropna().unique().tolist()),
                **group_metrics(group),
            })

    return {"sectors": sectors, "industries": industries}


def main():
    if not os.path.exists(INPUT_FILE):
        print(f"Error: {INPUT_FILE} not found.")
        return False

    stocks = load_json(INPUT_FILE)
    analytics = generate_analytics(stocks)
    save_json(SECTOR_OUTPUT_FILE, analytics)
    print(
        f"Saved breadth for {len(analytics['sectors'])} sectors and "
        f"{len(analytics['industries'])} industries without RS fields."
    )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
