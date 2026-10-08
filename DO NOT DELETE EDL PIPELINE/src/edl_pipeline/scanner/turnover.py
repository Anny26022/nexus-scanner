"""Official daily traded value, in rupees; missing sessions are never estimated."""
import numpy as np
import pandas as pd


def average_turnover_crore(frame, window):
    if window <= 0 or len(frame) < window:
        return None
    values = pd.to_numeric(frame.get('Turnover', pd.Series(index=frame.index, dtype=float)), errors='coerce').tail(window)
    if values.isna().any() or not np.isfinite(values).all() or (values < 0).any():
        return None
    return float(values.mean() / 10_000_000)
