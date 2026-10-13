"""Compact, date-aligned facts from the same engine used by Python screens."""
import json
from pathlib import Path

import pandas as pd
import scanner_bridge as bridge
from edl_pipeline.scanner.trend import _ma, _extreme_run
from edl_pipeline.scanner.financials import finite_number

CONFIG_PATH = Path(__file__).parent / 'src/data/snapshotTechnicals.json'
CONFIGURATIONS = json.loads(CONFIG_PATH.read_text())
MA_PERIODS = (9, 10, 20, 21, 50, 150, 200)


def technical_metrics(stock, frame, context, session):
    metrics = {}
    if frame is None or frame.empty or frame['Date'].iloc[-1].strftime('%Y-%m-%d') != session:
        return metrics
    metrics['historySessions'] = len(frame)
    for kind in ('sma', 'ema'):
        for period in MA_PERIODS:
            average = _ma(frame, kind, period)
            metrics[f'{kind}{period}'] = finite_number(average.iloc[-1])
            if kind == 'ema':
                metrics[f'emaValid{period}'] = int(average.notna().sum())
                for side in ('above', 'below'):
                    metrics[f'ema{side.title()}Run{period}'] = _extreme_run(frame, average, side)
    evaluation_context = {**context, 'stock': stock, 'screen_date': session}
    for config in CONFIGURATIONS:
        identifier = config['id']
        params = dict(config['fixed'])
        if config.get('threshold'):
            params[config['threshold']] = 1 if identifier in {'CONSECUTIVE_UP_DAYS', 'mom_consecutive_up'} else 0
            if config.get('comparison'):
                params[config['comparison']] = 'ABOVE'
        if identifier in {'LISTING_AGE_DAYS', 'DAYS_SINCE_EARNINGS'}:
            marker = pd.to_datetime(stock.get('listing_date' if identifier == 'LISTING_AGE_DAYS' else 'latest_earnings_date'), errors='coerce')
            # Do not undercount lifetime sessions when history begins after the marker.
            if pd.isna(marker) or marker.date() < frame['Date'].iloc[0].date():
                metrics[identifier] = None
                continue
        expression = bridge._evaluate_expression(frame, bridge.translate(identifier, params), [], evaluation_context)
        result = bridge._leaf_results(expression)[0]
        metrics[identifier] = None if result['status'] == 'unavailable' else (
            finite_number(result['details'].get('raw_value', result['value'])) if config.get('threshold') else int(result['status'] == 'match'))
    return metrics
