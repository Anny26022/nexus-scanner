"""Per-security indicators used by the breadth aggregator."""

import numpy as np
import pandas as pd

from ..scanner.indicators import prior_extremes, rsi


REQUIRED_COLUMNS = ("Date", "Open", "High", "Low", "Close", "Volume")
# Sessions after a 20-day breakout at which it is judged held or failed.
BREAKOUT_CHECK_SESSIONS = 5


def _rsi(series, period=14):
    return rsi(series, period)


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
        (df[f"{label}_Reference_High"], df[f"{label}_Reference_Low"],
         df[f"New_{label}_High"], df[f"New_{label}_Low"]) = prior_extremes(df, sessions)

    df["Volume_SMA_20"] = df["Volume"].rolling(20, min_periods=20).mean()
    valid_20d_candle = df["High"].notna() & df["Low"].notna()
    df["Prior_20_High"] = df["High"].shift(1).rolling(20, min_periods=20).max().where(valid_20d_candle)
    df["Prior_20_Low"] = df["Low"].shift(1).rolling(20, min_periods=20).min().where(valid_20d_candle)
    # Breadth breakouts use the same closing-price rule as the scanner.
    df["Breakout_20d"] = df["Close"] > df["Prior_20_High"]
    df["Breakdown_20d"] = df["Close"] < df["Prior_20_Low"]
    # A breakout resolves BREAKOUT_CHECK_SESSIONS later: it held when the close is still above the level it cleared.
    broke_out = df["Breakout_20d"].shift(BREAKOUT_CHECK_SESSIONS, fill_value=False).astype(bool)
    df["Breakout_Resolved"] = broke_out
    df["Breakout_Held"] = broke_out & (df["Close"] > df["Prior_20_High"].shift(BREAKOUT_CHECK_SESSIONS))
    # Weinstein-style stage, as the scanner's market page: price against the 150-day average, and the 50-day's side of it.
    sma_150 = df["Close"].rolling(150, min_periods=150).mean()
    staged = sma_150.notna() & df["SMA_50"].notna()
    above, rising = df["Close"] > sma_150, df["SMA_50"] > sma_150
    for stage, mask in ((1, above & ~rising), (2, above & rising), (3, ~above & rising), (4, ~above & ~rising)):
        df[f"Stage_{stage}"] = staged & mask
    df["Yearly_Range_High"] = df["High"].rolling(methodology.yearly_sessions, min_periods=methodology.yearly_sessions).max()
    df["Yearly_Range_Low"] = df["Low"].rolling(methodology.yearly_sessions, min_periods=methodology.yearly_sessions).min()
    df["Return_21"] = (df["Close"] / df["Close"].shift(methodology.monthly_sessions) - 1) * 100
    df["Return_34"] = (df["Close"] / df["Close"].shift(34) - 1) * 100
    df["Return_63"] = (df["Close"] / df["Close"].shift(methodology.quarterly_sessions) - 1) * 100
    df["RSI_14"] = _rsi(df["Close"], 14)
    df["Date"] = df["Date"].dt.strftime("%Y-%m-%d")
    return df
