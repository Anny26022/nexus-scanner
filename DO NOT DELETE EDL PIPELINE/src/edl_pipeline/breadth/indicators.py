"""Per-security indicators used by the breadth aggregator."""

import numpy as np
import pandas as pd


REQUIRED_COLUMNS = ("Date", "Open", "High", "Low", "Close", "Volume")


def _rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    average_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    average_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    relative_strength = average_gain / average_loss.replace(0, np.nan)
    result = 100 - (100 / (1 + relative_strength))
    result = result.mask((average_loss == 0) & (average_gain > 0), 100.0)
    result = result.mask((average_loss == 0) & (average_gain == 0), 50.0)
    return result


def prepare_history(frame, methodology):
    """Normalize an OHLCV frame and calculate all stock-level features."""
    missing = [column for column in REQUIRED_COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError(f"Missing OHLCV columns: {', '.join(missing)}")

    df = frame.loc[:, REQUIRED_COLUMNS].copy()
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    for column in ("Open", "High", "Low", "Close", "Volume"):
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df.loc[:, ("Open", "High", "Low", "Close", "Volume")] = df.loc[
        :, ("Open", "High", "Low", "Close", "Volume")
    ].replace([np.inf, -np.inf], np.nan)

    df = (
        df.dropna(subset=["Date", "Close"])
        .loc[lambda rows: rows["Close"] > 0]
        .sort_values("Date")
        .drop_duplicates("Date", keep="last")
        .reset_index(drop=True)
    )
    if df.empty:
        return df

    df["Prev_Close"] = df["Close"].shift(1)
    df["Daily_Return"] = (df["Close"] / df["Prev_Close"] - 1) * 100

    for period in methodology.ma_periods:
        df[f"SMA_{period}"] = df["Close"].rolling(period, min_periods=period).mean()
        df[f"EMA_{period}"] = df["Close"].ewm(
            span=period,
            adjust=False,
            min_periods=period,
        ).mean()

    for label, sessions in (
        ("Monthly", methodology.monthly_sessions),
        ("Quarterly", methodology.quarterly_sessions),
        ("Yearly", methodology.yearly_sessions),
    ):
        prior_high = df["High"].shift(1).rolling(sessions, min_periods=sessions).max()
        prior_low = df["Low"].shift(1).rolling(sessions, min_periods=sessions).min()
        df[f"{label}_Reference_High"] = prior_high
        df[f"{label}_Reference_Low"] = prior_low
        df[f"New_{label}_High"] = df["High"] > prior_high
        df[f"New_{label}_Low"] = df["Low"] < prior_low

    df["Volume_SMA_20"] = df["Volume"].rolling(20, min_periods=20).mean()
    df["Prior_20_High"] = df["High"].shift(1).rolling(20, min_periods=20).max()
    df["Prior_20_Low"] = df["Low"].shift(1).rolling(20, min_periods=20).min()
    df["Breakout_20d"] = df["High"] > df["Prior_20_High"]
    df["Breakdown_20d"] = df["Low"] < df["Prior_20_Low"]
    df["Yearly_Range_High"] = df["High"].rolling(methodology.yearly_sessions, min_periods=methodology.yearly_sessions).max()
    df["Yearly_Range_Low"] = df["Low"].rolling(methodology.yearly_sessions, min_periods=methodology.yearly_sessions).min()
    df["Return_21"] = (df["Close"] / df["Close"].shift(methodology.monthly_sessions) - 1) * 100
    df["Return_34"] = (df["Close"] / df["Close"].shift(34) - 1) * 100
    df["Return_63"] = (df["Close"] / df["Close"].shift(methodology.quarterly_sessions) - 1) * 100
    df["RSI_14"] = _rsi(df["Close"], 14)
    df["Date"] = df["Date"].dt.strftime("%Y-%m-%d")
    return df
