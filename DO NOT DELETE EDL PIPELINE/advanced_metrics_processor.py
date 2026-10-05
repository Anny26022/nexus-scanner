import pandas as pd
import os
import glob
import sys
import math
from concurrent.futures import ThreadPoolExecutor

from pipeline_utils import BASE_DIR, apply_sma_fields, load_json, save_json

# --- Configuration ---
JSON_INPUT = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json")
PRICE_BANDS_FILE = os.path.join(BASE_DIR, "complete_price_bands.json")
OHLCV_DIR = os.path.join(BASE_DIR, "ohlcv_data")
JSON_OUTPUT = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json")

SCANNER_DERIVED_FIELDS = [
    'as_of_date', 'gap_percent', 'range_percent', 'avg_volume_20',
    'avg_rupee_volume_20', 'relative_volume_20', 'atr14', 'atr_percent_14',
    'adr20', 'adr_percent_20', 'close_above_sma10', 'close_above_sma20',
    'close_above_sma50', 'close_above_sma200', 'sma10_above_sma20',
    'sma20_above_sma50', 'sma50_above_sma200', 'bullish_candle',
    'close_near_day_high', 'breakout_above_20d_high', 'breakout_above_50d_high',
    'near_52w_high', 'breakout_above_52w_high', 'is_nr7', 'is_inside_day',
    'is_bullish_engulfing', 'distance_from_sma20_percent',
    'distance_from_sma50_percent', 'distance_from_sma200_percent',
    'distance_from_52w_high_percent', 'distance_from_52w_low_percent',
    'sma50_crossed_above_sma200_today',
]

# These values come from the current ScanX response.  The OHLCV cache is used
# for historical calculations, but must never replace the live scanner quote
# or its vendor-calculated moving averages.
LIVE_SCANNER_FIELDS = {'rupee_volume', 'sma10', 'sma20', 'sma50', 'sma200'}

def calculate_ema(series, periods):
    return series.ewm(span=periods, adjust=False).mean()


def value_or_none(value, digits=2):
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def boolean_or_none(condition, available):
    return bool(condition()) if available else None


def merge_historical_metrics(stock, metrics):
    """Add cache-derived fields without replacing current ScanX fields."""
    for field, value in metrics.items():
        if field not in LIVE_SCANNER_FIELDS:
            stock[field] = value


def drop_copied_live_snapshot(df):
    """Drop a non-trading-day snapshot copied verbatim from the prior session."""
    columns = ['Open', 'High', 'Low', 'Close', 'Volume']
    latest_is_weekend = (
        'Date' in df.columns
        and pd.to_datetime(df['Date'].iloc[-1], errors='coerce').weekday() >= 5
    )
    if latest_is_weekend and len(df) > 1 and df[columns].iloc[-1].equals(df[columns].iloc[-2]):
        return df.iloc[:-1].copy()
    return df


def process_symbol_csv(csv_path):
    sym = os.path.basename(csv_path).replace(".csv", "")
    try:
        df = pd.read_csv(csv_path)
        if df.empty:
            return sym, None

        # Ensure numeric
        for col in ['Open', 'High', 'Low', 'Close', 'Volume']:
            df[col] = pd.to_numeric(df[col], errors='coerce')
        
        df = df.replace([float('inf'), float('-inf')], float('nan')).dropna(subset=['Open','High','Low','Close','Volume'])
        if df.empty: return sym, None

        df = df.sort_values('Date') if 'Date' in df.columns else df
        df = drop_copied_live_snapshot(df)
        if df.empty:
            return sym, None

        # Latest row
        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else latest

        # --- Calculations ---
        
        # 1. ATH
        ath = df['High'].max()
        pct_from_ath = ((ath - latest['Close']) / ath) * 100 if ath > 0 else 0
        
        # 2. Gap Up % and Day Range %
        gap_up_pct = ((latest['Open'] - prev['Close']) / prev['Close']) * 100 if len(df) >= 2 and prev['Close'] > 0 else None
        day_range_pct = ((latest['High'] - latest['Low']) / latest['Low']) * 100 if latest['Low'] > 0 else None
        
        # 3. ADR (Average Daily Range)
        df['Daily_Range_Pct'] = ((df['High'] - df['Low']) / df['Low']) * 100
        adr_5 = df['Daily_Range_Pct'].tail(5).mean()
        adr_14 = df['Daily_Range_Pct'].tail(14).mean()
        adr_20 = df['Daily_Range_Pct'].tail(20).mean()
        adr_30 = df['Daily_Range_Pct'].tail(30).mean()

        # 4. Returns & Low Benchmarks
        # 6 Month Return (~126 trading days)
        price_6m_ago = df['Close'].iloc[-127] if len(df) >= 127 else None
        returns_6m = ((latest['Close'] - price_6m_ago) / price_6m_ago) * 100 if price_6m_ago is not None and price_6m_ago > 0 else None
        
        # 52W Low (~252 trading days)
        low_52w = df['Low'].tail(252).min()
        pct_from_52w_low = ((latest['Close'] - low_52w) / low_52w) * 100 if len(df) >= 252 and low_52w > 0 else None

        # 5. Volume Metrics
        official = pd.to_numeric(df.get('Turnover', pd.Series(index=df.index,dtype=float)), errors='coerce')
        df['Turnover_Cr'] = official.where(official >= 0) / 10000000
        avg_rupee_vol_30 = df['Turnover_Cr'].rolling(30,min_periods=30).mean().iloc[-1]
        
        df['EMA_Vol_200'] = calculate_ema(df['Volume'], 200)
        ema_vol_200_latest = df['EMA_Vol_200'].iloc[-1]
        
        # % from 52W High of 200D EMA Volume
        ema_vol_200_52w_high = df['EMA_Vol_200'].tail(252).max()
        pct_from_ema_200_52w_high = ((ema_vol_200_latest - ema_vol_200_52w_high) / ema_vol_200_52w_high) * 100 if ema_vol_200_52w_high > 0 else 0

        # 6. Turnover Moving Averages
        turnover_20 = df['Turnover_Cr'].rolling(20,min_periods=20).mean().iloc[-1]
        turnover_50 = df['Turnover_Cr'].rolling(50,min_periods=50).mean().iloc[-1]
        turnover_100 = df['Turnover_Cr'].rolling(100,min_periods=100).mean().iloc[-1]

        # 7. Normalized scanner fields. Values are null when there is not enough
        # history to calculate a trustworthy metric.
        close = float(latest['Close'])
        high = float(latest['High'])
        low = float(latest['Low'])
        open_price = float(latest['Open'])
        volume = float(latest['Volume'])
        prior_20 = df.iloc[-21:-1] if len(df) >= 21 else pd.DataFrame()

        sma_series = {
            period: df['Close'].rolling(period, min_periods=period).mean()
            for period in (10, 20, 50, 200)
        }
        rolling_sma = {
            period: series.iloc[-1] if len(df) >= period else None
            for period, series in sma_series.items()
        }
        previous_sma = {
            period: series.iloc[-2] if len(df) >= period + 1 else None
            for period, series in sma_series.items()
        }

        true_range = pd.concat([
            df['High'] - df['Low'],
            (df['High'] - df['Close'].shift(1)).abs(),
            (df['Low'] - df['Close'].shift(1)).abs(),
        ], axis=1).max(axis=1)
        atr14 = true_range.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean().iloc[-1] if len(df) >= 14 else None
        adr20 = (df['High'] - df['Low']).tail(20).mean() if len(df) >= 20 else None
        adr_percent_20 = (((df['High']-df['Low'])/df['Close'])*100).tail(20).mean() if len(df) >= 20 else None
        avg_volume_20 = prior_20['Volume'].mean() if len(prior_20) == 20 else None
        avg_rupee_volume_20 = prior_20['Turnover_Cr'].mean()*1e7 if len(prior_20) == 20 and prior_20['Turnover_Cr'].notna().all() else None

        prior_20_high = df['High'].iloc[-21:-1].max() if len(df) >= 21 else None
        prior_50_high = df['High'].iloc[-51:-1].max() if len(df) >= 51 else None
        prior_52w_high = df['High'].iloc[-253:-1].max() if len(df) >= 253 else None
        current_range = high - low
        prior_six_ranges = (df['High'] - df['Low']).iloc[-7:-1] if len(df) >= 7 else pd.Series(dtype=float)

        scanner_metrics = {
            'as_of_date': str(latest['Date']) if 'Date' in df.columns else None,
            'rupee_volume': value_or_none(close * volume),
            'gap_percent': value_or_none(gap_up_pct),
            'range_percent': value_or_none(day_range_pct),
            'avg_volume_20': value_or_none(avg_volume_20, 0),
            'avg_rupee_volume_20': value_or_none(avg_rupee_volume_20),
            'relative_volume_20': value_or_none(volume / avg_volume_20) if avg_volume_20 and avg_volume_20 > 0 else None,
            'atr14': value_or_none(atr14),
            'atr_percent_14': value_or_none((atr14 / close) * 100) if atr14 is not None and close > 0 else None,
            'adr20': value_or_none(adr20),
            'adr_percent_20': value_or_none(adr_percent_20),
            'range_percent_low': value_or_none(day_range_pct),
            'adr_percent_low_20': value_or_none(adr_20) if len(df)>=20 else None,
            'adr_denominator': 'CLOSE',
            'legacy_adr_denominator': 'LOW',
            'atr_method': 'WILDER_EWM_FIRST_TR',
            'atr_simple_14': value_or_none(true_range.rolling(14,min_periods=14).mean().iloc[-1]),
            'close_above_sma10': boolean_or_none(lambda: close > rolling_sma[10], rolling_sma[10] is not None),
            'close_above_sma20': boolean_or_none(lambda: close > rolling_sma[20], rolling_sma[20] is not None),
            'close_above_sma50': boolean_or_none(lambda: close > rolling_sma[50], rolling_sma[50] is not None),
            'close_above_sma200': boolean_or_none(lambda: close > rolling_sma[200], rolling_sma[200] is not None),
            'sma10_above_sma20': boolean_or_none(lambda: rolling_sma[10] > rolling_sma[20], rolling_sma[10] is not None and rolling_sma[20] is not None),
            'sma20_above_sma50': boolean_or_none(lambda: rolling_sma[20] > rolling_sma[50], rolling_sma[20] is not None and rolling_sma[50] is not None),
            'sma50_above_sma200': boolean_or_none(lambda: rolling_sma[50] > rolling_sma[200], rolling_sma[50] is not None and rolling_sma[200] is not None),
            'sma50_crossed_above_sma200_today': boolean_or_none(
                lambda: previous_sma[50] <= previous_sma[200] and rolling_sma[50] > rolling_sma[200],
                previous_sma[50] is not None and previous_sma[200] is not None,
            ),
            'distance_from_sma20_percent': value_or_none(((close - rolling_sma[20]) / rolling_sma[20]) * 100) if rolling_sma[20] else None,
            'distance_from_sma50_percent': value_or_none(((close - rolling_sma[50]) / rolling_sma[50]) * 100) if rolling_sma[50] else None,
            'distance_from_sma200_percent': value_or_none(((close - rolling_sma[200]) / rolling_sma[200]) * 100) if rolling_sma[200] else None,
            'distance_from_52w_high_percent': value_or_none(((close - prior_52w_high) / prior_52w_high) * 100) if prior_52w_high else None,
            'distance_from_52w_low_percent': value_or_none(pct_from_52w_low),
            'bullish_candle': close > open_price,
            'close_near_day_high': boolean_or_none(
                lambda: (high - close) / current_range <= 0.25,
                current_range > 0,
            ),
            'breakout_above_20d_high': boolean_or_none(lambda: close > prior_20_high, prior_20_high is not None),
            'breakout_above_50d_high': boolean_or_none(lambda: close > prior_50_high, prior_50_high is not None),
            'near_52w_high': boolean_or_none(lambda: close >= prior_52w_high * 0.95, prior_52w_high is not None),
            'breakout_above_52w_high': boolean_or_none(lambda: close > prior_52w_high, prior_52w_high is not None),
            'is_nr7': boolean_or_none(lambda: current_range <= prior_six_ranges.min(), len(prior_six_ranges) == 6),
            'is_inside_day': boolean_or_none(lambda: high <= float(prev['High']) and low >= float(prev['Low']), len(df) >= 2),
            'is_bullish_engulfing': boolean_or_none(
                lambda: close > open_price and float(prev['Close']) < float(prev['Open'])
                and open_price <= float(prev['Close']) and close >= float(prev['Open']),
                len(df) >= 2,
            ),
        }
        scanner_metrics.update({
            f'sma{period}': value_or_none(value)
            for period, value in rolling_sma.items() if value is not None
        })

        return sym, {
            "30 Days Average Rupee Volume(Cr.)": value_or_none(avg_rupee_vol_30) if len(df) >= 30 else None,
            "RVOL": scanner_metrics['relative_volume_20'],
            "Daily Rupee Turnover 20(Cr.)": value_or_none(turnover_20) if len(df) >= 20 else None,
            "Daily Rupee Turnover 50(Cr.)": value_or_none(turnover_50) if len(df) >= 50 else None,
            "Daily Rupee Turnover 100(Cr.)": value_or_none(turnover_100) if len(df) >= 100 else None,
            "200 Days EMA Volume": value_or_none(ema_vol_200_latest, 0) if len(df) >= 200 else None,
            "% from 52W High 200 Days EMA Volume": value_or_none(pct_from_ema_200_52w_high) if len(df) >= 451 else None,
            "5 Days MA ADR(%)": value_or_none(adr_5) if len(df) >= 5 else None,
            "14 Days MA ADR(%)": value_or_none(adr_14) if len(df) >= 14 else None,
            "20 Days MA ADR(%)": value_or_none(adr_20) if len(df) >= 20 else None,
            "30 Days MA ADR(%)": value_or_none(adr_30) if len(df) >= 30 else None,
            "% from ATH": round(pct_from_ath, 2),
            "ATH_Value": round(ath, 2),
            "Gap Up %": value_or_none(gap_up_pct),
            "Day Range(%)": value_or_none(day_range_pct),
            "6 Month Returns(%)": value_or_none(returns_6m),
            "% from 52W Low": value_or_none(pct_from_52w_low),
            **scanner_metrics,
        }
    except Exception as e:
        return sym, None

def main():
    print("Loading base analysis data...")
    try:
        base_data = load_json(JSON_INPUT)
    except Exception as e:
        print(f"Error: {JSON_INPUT} not found. Run bulk_market_analyzer.py first.")
        return False

    print("Loading Price Bands (Circuit Limits)...")
    price_band_map = {}
    try:
        for item in load_json(PRICE_BANDS_FILE):
            price_band_map[item.get("Symbol")] = item.get("Band")
    except Exception:
        print("Warning: Price bands file not found.")

    print("Processing OHLCV metrics for all stocks...")
    csv_files = glob.glob(os.path.join(OHLCV_DIR, "*.csv"))
    
    advanced_metrics_map = {}
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(process_symbol_csv, cf) for cf in csv_files]
        for future in futures:
            sym, result = future.result()
            if result:
                advanced_metrics_map[sym] = result

    print(f"Updating {len(base_data)} stocks in master JSON...")
    
    for stock in base_data:
        sym = stock.get("Symbol")
        
        # 1. Update Circuit Limit
        if sym in price_band_map:
            stock["Circuit Limit"] = price_band_map[sym]
        
        # 2. Update Advanced Metrics
        if sym in advanced_metrics_map:
            metrics = advanced_metrics_map[sym]
            
            # --- HYBRID FIX: Eliminate 1-day lag ---
            # Use Live LTP from master_data if available
            live_ltp = pd.to_numeric(stock.get("close", stock.get("Stock Price(₹)")), errors='coerce')
            if pd.notnull(live_ltp) and live_ltp > 0:
                ath = metrics.get("ATH_Value", 0)
                if ath > 0:
                    metrics["% from ATH"] = round(((ath - live_ltp) / ath) * 100, 2)
            
            # Merge historical calculations without replacing current ScanX
            # turnover or moving averages with values from the OHLCV cache.
            merge_historical_metrics(stock, metrics)
            if "ATH_Value" in stock: del stock["ATH_Value"]
        else:
            # Missing history is not a measured zero.
            placeholders = [
                "30 Days Average Rupee Volume(Cr.)", "RVOL", 
                "Daily Rupee Turnover 20(Cr.)", "Daily Rupee Turnover 50(Cr.)", "Daily Rupee Turnover 100(Cr.)",
                "200 Days EMA Volume", "% from 52W High 200 Days EMA Volume", "5 Days MA ADR(%)", 
                "14 Days MA ADR(%)", "20 Days MA ADR(%)", "30 Days MA ADR(%)", "% from ATH", 
                "Gap Up %", "Day Range(%)", "6 Month Returns(%)", "% from 52W Low"
            ]
            for p in placeholders:
                if p not in stock: stock[p] = None

        # Reconcile every stock, including symbols without usable OHLCV
        # history, against the live ScanX values published in the artifact.
        apply_sma_fields(stock)
        for field in SCANNER_DERIVED_FIELDS:
            stock.setdefault(field, None)

    save_json(JSON_OUTPUT, base_data)
    
    print(f"Successfully updated master JSON: {JSON_OUTPUT}")
    return True

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
