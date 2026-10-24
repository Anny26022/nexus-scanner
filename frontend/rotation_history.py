"""Price history behind the Rotation page: everything an RRG needs, for any timeframe and replay date.

The page computes RS-Ratio and RS-Momentum in the browser, so this file stores prices rather than chart
points: one aligned series per stock, per classification group and per benchmark, on three calendars
(daily, weekly, monthly). Groups are equal-weighted composites of their current members' daily returns.

Values are delta-coded natural logs scaled by 10,000 (0.01% resolution), which gzip compresses well.
Stocks are split into a core shard (the broad index) and the rest, so most views load one small file.
"""
from datetime import date
import gzip
import hashlib
import json
import math

SCHEMA_VERSION = 1
# Each calendar keeps enough periods for its longest range plus the 14-period lookback and a long trail.
PERIODS = {'D': 300, 'W': 290, 'M': 144}
SCALE = 10_000
LEVELS = ('sector', 'industry', 'subIndustry', 'theme', 'block', 'macro')
# A composite needs a few members to mean anything; illiquid microcaps would dominate equal weights.
MIN_MEMBERS = 3
MIN_GROUP_MARKET_CAP_CR = 300.0
MIN_GROUP_TURNOVER30_CR = 1.0
MAX_DAILY_RETURN = (-0.6, 1.5)
BENCHMARKS = {'N50': 'Nifty 50', 'N500': 'Nifty 500', 'EW': 'Equal-weight market'}
# Index symbols the refresh already fetches (indices_ohlcv_data and the daily index history).
BENCHMARK_INDICES = {'N50': 'NIFTY', 'N500': 'NIFTY 500'}
# Group composites are equal-weighted, so they are compared with an equal-weighted market built the same way:
# against a cap-weighted index every group would look strong whenever small and mid caps outperform.
# Index memberships offered as stock universes, keyed by the short codes the page uses.
UNIVERSES = {'N50': 'Nifty 50', 'N100': 'NIFTY 100', 'N500': 'NIFTY 500', 'MID150': 'NIFTY Midcap 150',
             'SML250': 'NIFTY Smallcap 250', 'MS400': 'Nifty MidSmallCap 400'}
CORE_UNIVERSE = 'N500'


def calendars(dates):
    """Daily, weekly (last session of each ISO week) and monthly (last session of each month) dates."""
    weekly, monthly = [], []
    for index, day in enumerate(dates):
        following = dates[index + 1] if index + 1 < len(dates) else None
        if following is None or date.fromisoformat(following).isocalendar()[:2] != date.fromisoformat(day).isocalendar()[:2]:
            weekly.append(day)
        if following is None or following[:7] != day[:7]:
            monthly.append(day)
    return {'D': dates[-PERIODS['D']:], 'W': weekly[-PERIODS['W']:], 'M': monthly[-PERIODS['M']:]}


def aligned(points, dates):
    """Closes on each calendar date, carried forward over gaps; None before the first observation."""
    values, cursor, last = [], 0, None
    for day in dates:
        while cursor < len(points) and points[cursor][0] <= day:
            close = points[cursor][1]
            if close is not None and close > 0 and math.isfinite(close):
                last = close
            cursor += 1
        values.append(last)
    return values


def encode(values):
    """[offset, first, delta...] of round(ln(value) * SCALE); None when the series never starts."""
    start = next((index for index, value in enumerate(values) if value is not None), None)
    if start is None:
        return None
    coded, previous = [start], None
    for value in values[start:]:
        current = round(math.log(value) * SCALE) if value is not None else previous
        coded.append(current if previous is None else current - previous)
        previous = current
    return coded


def composite(member_closes, dates):
    """Equal-weight chain index of member returns on the daily calendar; None until enough members trade."""
    levels, level, started = [], 100.0, False
    previous = [None] * len(member_closes)
    for index in range(len(dates)):
        total = count = 0
        for position, closes in enumerate(member_closes):
            close = closes[index]
            if close is not None and previous[position] is not None:
                change = min(max(close / previous[position] - 1, MAX_DAILY_RETURN[0]), MAX_DAILY_RETURN[1])
                total += change
                count += 1
            previous[position] = close if close is not None else previous[position]
        if not started:
            started = sum(close is not None for close in previous) >= MIN_MEMBERS
            levels.append(level if started else None)
            continue
        if count:
            level *= 1 + total / count
        levels.append(level)
    return levels


def number(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def group_eligible(row):
    cap, turnover = number(row.get('marketCapCrore')), number((row.get('metrics') or {}).get('turnover30'))
    return cap is not None and cap >= MIN_GROUP_MARKET_CAP_CR and turnover is not None and turnover >= MIN_GROUP_TURNOVER30_CR


def build(session, rows, closes, benchmarks, taxonomy):
    """Rotation history objects for one release.

    rows: published stock rows; closes: {symbol: [(date, close), ...]} ascending; benchmarks: {'N50': [...],
    'N500': [...]} in the same form; taxonomy: {symbol: {'theme', 'subIndustry', 'block', 'macro'}}.
    Returns (index, shards) where shards maps a shard name to its payload.
    """
    daily = [day for day, _ in benchmarks['N50'] if day <= session]
    if len(daily) < PERIODS['D'] + 20:
        raise ValueError('Rotation history needs a longer benchmark history')
    frames = calendars(daily)
    # Group composites are built once on the daily calendar back to the earliest monthly date.
    composite_days = [day for day in daily if day >= frames['M'][0]]

    def series(points):
        return {frame: encode(aligned(points, dates)) for frame, dates in frames.items()}

    stocks, shards = [], {'core': {frame: {} for frame in frames}, 'rest': {frame: {} for frame in frames}}
    for row in sorted(rows, key=lambda item: item['symbol']):
        symbol = row['symbol']
        points = closes.get(symbol) or []
        if not points:
            continue
        memberships = set(row.get('indexMemberships') or [])
        universes = [code for code, name in UNIVERSES.items() if name in memberships]
        shard = 'core' if CORE_UNIVERSE in universes else 'rest'
        encoded = series(points)
        if encoded['D'] is None:
            continue
        for frame, coded in encoded.items():
            if coded is not None:
                shards[shard][frame][symbol] = coded
        entry = {'s': symbol, 'n': row.get('name') or symbol, 'u': universes, 'h': shard}
        # The screener's liquidity fields, so the page can filter on the same terms.
        cap, turnover = number(row.get('marketCapCrore')), number((row.get('metrics') or {}).get('turnover30'))
        if cap is not None:
            entry['c'] = round(cap, 1)
        if turnover is not None:
            entry['t'] = round(turnover, 2)
        if row.get('circuitLimit') not in (None, ''):
            entry['b'] = str(row['circuitLimit'])
        stocks.append(entry)

    members = {level: {} for level in LEVELS}
    for row in rows:
        if not group_eligible(row) or row['symbol'] not in closes:
            continue
        labels = dict(sector=row.get('sector'), industry=row.get('industry'), **{
            key: (taxonomy.get(row['symbol']) or {}).get(key) for key in ('subIndustry', 'theme', 'block', 'macro')})
        for level in LEVELS:
            label = (labels.get(level) or '').strip()
            if label and label.lower() not in ('unclassified', 'others', 'other', 'n/a'):
                members[level].setdefault(label, []).append(row['symbol'])
    groups, shards['groups'] = [], {frame: {} for frame in frames}
    daily_closes = {}
    market = sorted({symbol for level in members.values() for symbols in level.values() for symbol in symbols})
    for symbol in market:
        daily_closes[symbol] = aligned(closes[symbol], composite_days)
    if len(market) >= MIN_MEMBERS:
        levels = composite([daily_closes[symbol] for symbol in market], composite_days)
        benchmarks = dict(benchmarks, EW=[(day, value) for day, value in zip(composite_days, levels) if value is not None])
    for level in LEVELS:
        for label, symbols in sorted(members[level].items()):
            if len(symbols) < MIN_MEMBERS:
                continue
            levels = composite([daily_closes[symbol] for symbol in sorted(symbols)], composite_days)
            points = [(day, value) for day, value in zip(composite_days, levels) if value is not None]
            if not points:
                continue
            key = f'{level}:{label}'
            for frame, coded in series(points).items():
                if coded is not None:
                    shards['groups'][frame][key] = coded
            groups.append({'id': key, 'l': level, 'n': label, 'm': sorted(symbols)})

    index = {
        'schemaVersion': SCHEMA_VERSION, 'asOfDate': session, 'scale': SCALE,
        'frames': frames,
        'benchmarks': {code: {'name': BENCHMARKS[code], 'series': series(points)} for code, points in benchmarks.items()},
        'universes': {code: name for code, name in UNIVERSES.items()},
        'stocks': stocks, 'groups': groups,
    }
    return index, shards


def packed(value):
    """Deterministic gzip bytes and their content hash, ready for the object store."""
    data = gzip.compress(json.dumps(value, separators=(',', ':'), sort_keys=True, allow_nan=False).encode(),
                         compresslevel=9, mtime=0)
    return hashlib.sha256(data).hexdigest(), data


def write_objects(objects, index, shards):
    """Write the shards and the index (which names them) as content-addressed objects; returns the index hash."""
    objects.mkdir(parents=True, exist_ok=True)
    references = {}
    for name, shard in sorted(shards.items()):
        digest, data = packed({'schemaVersion': SCHEMA_VERSION, 'asOfDate': index['asOfDate'], 'shard': name, 'series': shard})
        (objects / f'{digest}.json.gz').write_bytes(data)
        references[name] = digest
    digest, data = packed(dict(index, shards=references))
    (objects / f'{digest}.json.gz').write_bytes(data)
    return digest
