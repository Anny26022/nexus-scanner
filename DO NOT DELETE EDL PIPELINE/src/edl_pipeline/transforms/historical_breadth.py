"""Generate the legacy market breadth CSV from OHLCV history."""

import glob
import os
import sys

import numpy as np
import pandas as pd

from pipeline_utils import BASE_DIR, load_json


SYMBOL_OHLCV_DIR = os.path.join(BASE_DIR, "ohlcv_data")
INDEX_OHLCV_DIR = os.path.join(BASE_DIR, "indices_ohlcv_data")
MASTER_STOCKS_FILE = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json")
OUTPUT_CSV = os.path.join(BASE_DIR, "market_breadth.csv")
LOOKBACK_DAYS = 250

INDEX_FILES = {
    "Nifty Midcap 150": "NIFTY_MIDCAP_150.csv",
    "Nifty Smallcap 250": "NIFTY_SMALLCAP_250.csv",
    "Nifty Midsmallcap 400": "NIFTY_MIDSMALLCAP_400.csv",
    "Nifty 50": "NIFTY.csv",
    "Nifty 500": "NIFTY_500.csv",
}


def load_valid_symbols(path=MASTER_STOCKS_FILE):
    if not os.path.exists(path):
        print("Error: Run bulk_market_analyzer first.")
        return None
    stocks_data = load_json(path)
    return {stock["Symbol"] for stock in stocks_data}


def load_timeline():
    nifty_path = os.path.join(INDEX_OHLCV_DIR, "NIFTY.csv")
    if not os.path.exists(nifty_path):
        print("Error: NIFTY index data not found.")
        return None
    nifty_df = pd.read_csv(nifty_path)
    return nifty_df["Date"].tail(LOOKBACK_DAYS).tolist()


def empty_breadth_arrays(num_days):
    return {
        "advances": np.zeros(num_days),
        "declines": np.zeros(num_days),
        "above_200ma": np.zeros(num_days),
        "above_50ma": np.zeros(num_days),
        "above_20ma": np.zeros(num_days),
        "above_10ma": np.zeros(num_days),
        "up_4pc": np.zeros(num_days),
        "down_4pc": np.zeros(num_days),
        "high_52w": np.zeros(num_days),
        "low_52w": np.zeros(num_days),
        "vol_plus": np.zeros(num_days),
        "vol_minus": np.zeros(num_days),
    }


def prepare_stock_history(csv_path, timeline):
    df = pd.read_csv(csv_path)
    original = df
    if df.empty or len(df) < 5:
        return None

    df = df[df["Date"].isin(timeline)].copy()
    if df.empty:
        return None

    full_df = original
    full_df["SMA_10"] = full_df["Close"].rolling(10).mean()
    full_df["SMA_20"] = full_df["Close"].rolling(20).mean()
    full_df["SMA_50"] = full_df["Close"].rolling(50).mean()
    full_df["SMA_200"] = full_df["Close"].rolling(200).mean()
    full_df["Vol_SMA_20"] = full_df["Volume"].rolling(20).mean()
    full_df["H_52W"] = full_df["High"].rolling(252).max()
    full_df["L_52W"] = full_df["Low"].rolling(252).min()
    full_df["Prev_Close"] = full_df["Close"].shift(1)
    full_df["Daily_Ret"] = ((full_df["Close"] - full_df["Prev_Close"]) / full_df["Prev_Close"]) * 100
    return full_df[full_df["Date"].isin(timeline)]


def update_breadth_arrays(analysis_df, date_to_idx, arrays):
    for row in analysis_df.itertuples(index=False):
        idx = date_to_idx.get(row.Date)
        if idx is None:
            continue

        if row.Close > row.Prev_Close:
            arrays["advances"][idx] += 1
        if row.Close < row.Prev_Close:
            arrays["declines"][idx] += 1

        if row.Close > row.SMA_200:
            arrays["above_200ma"][idx] += 1
        if row.Close > row.SMA_50:
            arrays["above_50ma"][idx] += 1
        if row.Close > row.SMA_20:
            arrays["above_20ma"][idx] += 1
        if row.Close > row.SMA_10:
            arrays["above_10ma"][idx] += 1

        if row.Daily_Ret >= 4:
            arrays["up_4pc"][idx] += 1
        if row.Daily_Ret <= -4:
            arrays["down_4pc"][idx] += 1

        if row.High >= row.H_52W:
            arrays["high_52w"][idx] += 1
        if row.Low <= row.L_52W:
            arrays["low_52w"][idx] += 1

        if row.Volume > row.Vol_SMA_20:
            arrays["vol_plus"][idx] += 1
        else:
            arrays["vol_minus"][idx] += 1


def process_stock_histories(valid_symbols, timeline):
    date_to_idx = {date: i for i, date in enumerate(timeline)}
    arrays = empty_breadth_arrays(len(timeline))
    processed_count = 0

    for csv_path in glob.glob(os.path.join(SYMBOL_OHLCV_DIR, "*.csv")):
        symbol = os.path.basename(csv_path).replace(".csv", "")
        if symbol not in valid_symbols:
            continue

        try:
            analysis_df = prepare_stock_history(csv_path, timeline)
            if analysis_df is None:
                continue
            update_breadth_arrays(analysis_df, date_to_idx, arrays)
            processed_count += 1
        except Exception:
            continue

    return arrays, processed_count


def load_index_data(timeline):
    index_data = {}
    for label, filename in INDEX_FILES.items():
        path = os.path.join(INDEX_OHLCV_DIR, filename)
        if os.path.exists(path):
            df = pd.read_csv(path)
            df = df[df["Date"].isin(timeline)]
            price_map = df.set_index("Date")["Close"].to_dict()
            index_data[label] = [round(price_map[date], 2) if date in price_map else None for date in timeline]
        else:
            index_data[label] = [None] * len(timeline)
    return index_data


def calc_ratio(advances, declines, window):
    ratios = []
    for i in range(len(advances)):
        start = max(0, i - window + 1)
        sum_adv = sum(advances[start:i + 1])
        sum_dec = sum(declines[start:i + 1])
        ratios.append(round(sum_adv / sum_dec, 2) if sum_dec > 0 else None)
    return ratios


def to_csv_row(label, values):
    return f"{label}," + ",".join("" if value is None else str(value) for value in values)


def build_breadth_rows(timeline, arrays, index_data, processed_count):
    num_days = len(timeline)
    total_tracked = max(processed_count, 1)
    rows = ["Type of Info," + ",".join(timeline)]

    rows.append(to_csv_row("Up by 4% Today", arrays["up_4pc"].astype(int)))
    rows.append(to_csv_row("Down by 4% Today", arrays["down_4pc"].astype(int)))
    rows.append(to_csv_row("5 Day Ratio", calc_ratio(arrays["advances"], arrays["declines"], 5)))
    rows.append(to_csv_row("10 Day Ratio", calc_ratio(arrays["advances"], arrays["declines"], 10)))

    for label in [
        "Up by 25% in Month",
        "Down by 25% in Month",
        "Up by 50% in Month",
        "Down by 50% in Month",
        "Up by 13% in 34 Days",
        "Down by 13% in 34 Days",
        "Up by 25% in Quarter",
        "Down by 25% in Quarter",
    ]:
        rows.append(to_csv_row(label, [None] * num_days))

    rows.append(to_csv_row("Above 200MA %", np.round(arrays["above_200ma"] / total_tracked * 100, 1)))
    rows.append(to_csv_row("Above 50MA %", np.round(arrays["above_50ma"] / total_tracked * 100, 1)))
    rows.append(to_csv_row("Above 20MA %", np.round(arrays["above_20ma"] / total_tracked * 100, 1)))
    rows.append(to_csv_row("Above 10MA %", np.round(arrays["above_10ma"] / total_tracked * 100, 1)))

    rows.append(to_csv_row("Reached 52w High", arrays["high_52w"].astype(int)))
    rows.append(to_csv_row("Reached 52w Low", arrays["low_52w"].astype(int)))
    rows.append(to_csv_row("Volume greater than 20Day Average", arrays["vol_plus"].astype(int)))
    rows.append(to_csv_row("Volume less than 20Day Average", arrays["vol_minus"].astype(int)))
    rows.append(to_csv_row("Nifty 500 % of W&M RSI > 60", [None] * num_days))
    rows.append(to_csv_row("Advances", arrays["advances"].astype(int)))
    rows.append(to_csv_row("Declines", arrays["declines"].astype(int)))

    for label, prices in index_data.items():
        rows.append(to_csv_row(label, prices))

    return rows


def calculate_historical_breadth():
    print("⏳ Loading master stock list...")
    valid_symbols = load_valid_symbols()
    if valid_symbols is None:
        return False
    print(f"Targeting {len(valid_symbols)} stocks for historical breadth.")

    timeline = load_timeline()
    if timeline is None:
        return False

    print("🧬 Processing stock-level history...")
    arrays, processed_count = process_stock_histories(valid_symbols, timeline)
    print(f"✅ Analyzed {processed_count} stocks. Merging with Index data...")

    rows = build_breadth_rows(timeline, arrays, load_index_data(timeline), processed_count)
    with open(OUTPUT_CSV, "w") as f:
        f.write("\n".join(rows))

    print(f"🚀 Market Breadth Historical Data generated: {OUTPUT_CSV}")
    return True


if __name__ == "__main__":
    sys.exit(0 if calculate_historical_breadth() else 1)
