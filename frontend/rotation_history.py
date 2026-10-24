"""Price history behind the Rotation page: everything an RRG needs, for any timeframe and replay date.

The page computes RS-Ratio and RS-Momentum in the browser, so this file stores prices rather than chart
points: one aligned series per stock, per classification group and per benchmark, on three calendars
(daily, weekly, monthly). Groups are equal-weighted composites of their members' daily returns, using each
day's membership from a dated ledger the pipeline keeps in its private state.

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
BENCHMARKS = {'N50': 'Nifty 50', 'N100': 'Nifty 100', 'N500': 'Nifty 500', 'MID150': 'Nifty Midcap 150',
              'SML250': 'Nifty Smallcap 250', 'MS400': 'Nifty MidSmallCap 400', 'TOTAL': 'Nifty Total Market',
              'EW': 'Equal-weight market'}
# Index symbols the refresh already fetches (indices_ohlcv_data and the daily index history). Codes match the
# stock universes, so each universe can be measured against its own index.
BENCHMARK_INDICES = {'N50': 'NIFTY', 'N100': 'NIFTY 100', 'N500': 'NIFTY 500', 'MID150': 'NIFTY MIDCAP 150',
                     'SML250': 'NIFTY SMALLCAP 250', 'MS400': 'NIFTY MIDSMALLCAP 400', 'TOTAL': 'NIFTY TOTAL MKT'}
# Group composites are equal-weighted, so they are compared with an equal-weighted market built the same way:
# against a cap-weighted index every group would look strong whenever small and mid caps outperform.
# Index memberships offered as stock universes, keyed by the short codes the page uses.
UNIVERSES = {'N50': 'Nifty 50', 'N100': 'NIFTY 100', 'N500': 'NIFTY 500', 'MID150': 'NIFTY Midcap 150',
             'SML250': 'NIFTY Smallcap 250', 'MS400': 'Nifty MidSmallCap 400'}
CORE_UNIVERSE = 'N500'
# Private, carried between runs: each stock's classification labels by date.
LEDGER_NAME = 'rotation_membership_ledger.json.gz'


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


def composite(members, length):
    """Equal-weight chain index of member returns on the daily calendar; None until enough members trade.

    members: (closes, spans) pairs, where spans are the [start, end) calendar ranges in which the stock
    belonged to the group. A stock counts only on days it was a member, so membership can change over time.
    """
    total, count = [0.0] * length, [0] * length
    for closes, spans in members:
        for start, end in spans:
            for index in range(max(1, start), min(end, length)):
                close, previous = closes[index], closes[index - 1]
                if close is not None and previous is not None:
                    total[index] += min(max(close / previous - 1, MAX_DAILY_RETURN[0]), MAX_DAILY_RETURN[1])
                    count[index] += 1
    levels, level, started = [], 100.0, False
    for index in range(length):
        if started and count[index]:
            level *= 1 + total[index] / count[index]
        # The group starts at 100 on the first day enough members trade; earlier returns do not count.
        started = started or count[index] >= MIN_MEMBERS
        levels.append(level if started else None)
    return levels


IGNORED_LABELS = ('unclassified', 'others', 'other', 'n/a')


def labels_of(row, taxonomy):
    """The stock's label at each level today; None where it is unclassified."""
    raw = dict(sector=row.get('sector'), industry=row.get('industry'),
               **{key: (taxonomy.get(row['symbol']) or {}).get(key) for key in ('subIndustry', 'theme', 'block', 'macro')})
    cleaned = [(raw.get(level) or '').strip() for level in LEVELS]
    return [label if label and label.lower() not in IGNORED_LABELS else None for label in cleaned]


def record_memberships(ledger, session, labels):
    """Append today's labels for every stock whose labels changed. The ledger only grows, by date."""
    if not isinstance(ledger, dict) or ledger.get('version') != 1 or list(ledger.get('levels', [])) != list(LEVELS):
        ledger = {'version': 1, 'levels': list(LEVELS), 'records': {}}
    records = ledger['records']
    for symbol, current in labels.items():
        history = records.setdefault(symbol, [])
        if history and history[-1][0] > session:
            raise ValueError('Membership ledger is ahead of this session')
        if not history or history[-1][1] != current:
            if history and history[-1][0] == session:
                history[-1] = [session, current]
            else:
                history.append([session, current])
    return ledger


def spans(history, days, level):
    """Calendar ranges per label at one level. Before the first record the earliest known label applies."""
    if not history:
        return {}
    out = {}
    starts = [0] + [next((i for i, day in enumerate(days) if day >= date), len(days)) for date, _ in history[1:]]
    ends = starts[1:] + [len(days)]
    for (_, labels), start, end in zip(history, starts, ends):
        label = labels[level]
        if label and end > start:
            out.setdefault(label, []).append((start, end))
    return out


def number(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def group_eligible(row):
    cap, turnover = number(row.get('marketCapCrore')), number((row.get('metrics') or {}).get('turnover30'))
    return cap is not None and cap >= MIN_GROUP_MARKET_CAP_CR and turnover is not None and turnover >= MIN_GROUP_TURNOVER30_CR


def build(session, rows, closes, benchmarks, taxonomy, ledger=None):
    """Rotation history objects for one release.

    rows: published stock rows; closes: {symbol: [(date, close), ...]} ascending; benchmarks: {'N50': [...],
    'N500': [...]} in the same form; taxonomy: {symbol: {'theme', 'subIndustry', 'block', 'macro'}};
    ledger: the dated membership ledger from earlier runs (None to start one).
    Returns (index, shards, ledger): shards maps a shard name to its payload; ledger includes today.
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

    # Group membership is point in time: the ledger records each stock's labels by date, and a stock counts
    # towards a group only on the days it belonged. Before the ledger began, the earliest known labels apply.
    today = {row['symbol']: labels_of(row, taxonomy) for row in rows if row['symbol'] in closes}
    ledger = record_memberships(ledger, session, today)
    eligible = sorted(row['symbol'] for row in rows if group_eligible(row) and row['symbol'] in closes)
    members = {level: {} for level in LEVELS}
    for symbol in eligible:
        for position, level in enumerate(LEVELS):
            if today[symbol][position]:
                members[level].setdefault(today[symbol][position], []).append(symbol)
    daily_closes = {symbol: aligned(closes[symbol], composite_days) for symbol in eligible}
    groups, shards['groups'] = [], {frame: {} for frame in frames}
    if len(eligible) >= MIN_MEMBERS:
        levels = composite([(daily_closes[symbol], [(0, len(composite_days))]) for symbol in eligible], len(composite_days))
        benchmarks = dict(benchmarks, EW=[(day, value) for day, value in zip(composite_days, levels) if value is not None])
    history_spans = {symbol: [spans(ledger['records'].get(symbol, []), composite_days, position) for position in range(len(LEVELS))]
                     for symbol in eligible}
    for position, level in enumerate(LEVELS):
        by_label = {}
        for symbol in eligible:
            for label, ranges in history_spans[symbol][position].items():
                by_label.setdefault(label, []).append((daily_closes[symbol], ranges))
        for label, symbols in sorted(members[level].items()):
            if len(symbols) < MIN_MEMBERS:
                continue
            levels = composite(by_label.get(label, []), len(composite_days))
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
        # An index the refresh could not supply this time is left out rather than published empty.
        'benchmarks': {code: {'name': BENCHMARKS[code], 'series': series(points)} for code, points in benchmarks.items()
                       if len(points) >= 2},
        'universes': {code: name for code, name in UNIVERSES.items()},
        'stocks': stocks, 'groups': groups,
    }
    return index, shards, ledger


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
