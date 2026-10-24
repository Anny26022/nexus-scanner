"""Price history behind the Rotation page: everything an RRG needs, for any timeframe and replay date.

The page computes RS-Ratio and RS-Momentum in the browser, so this file stores prices rather than chart
points: one aligned series per stock, per classification group and per benchmark, on three calendars
(daily, weekly, monthly). Groups are equal-weighted composites of their members' daily returns, using each
day's membership from a dated ledger the pipeline keeps in its private state.

Values are delta-coded natural logs scaled by 10,000 (0.01% resolution), which gzip compresses well.
Stocks are split into a core shard (the broad index) and the rest, so most views load one small file.
"""
from datetime import date
from array import array
from bisect import bisect_left
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
            if close is None or (close > 0 and math.isfinite(close)):
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
        if value is None:
            coded.append(None)  # Explicit missing coverage, not a flat return.
            continue
        current = round(math.log(value) * SCALE)
        coded.append(current if previous is None else current - previous)
        previous = current
    return coded


def accumulate(total, count, closes, ranges):
    for start, end in ranges:
        for index in range(max(1, start), min(end, len(total))):
            close, previous = closes[index], closes[index - 1]
            if close is not None and previous is not None:
                total[index] += min(max(close / previous - 1, MAX_DAILY_RETURN[0]), MAX_DAILY_RETURN[1])
                count[index] += 1


def chain(total, count):
    levels, level, started = [], 100.0, False
    for index in range(len(total)):
        if count[index] < MIN_MEMBERS:
            levels.append(None)
            started = False  # Resume at the retained level; never bridge an uncovered return.
            continue
        if started:
            level *= 1 + total[index] / count[index]
        started = True
        levels.append(level)
    return levels


def composite(members, length):
    """Equal-weight chain index of member returns on the daily calendar; None until enough members trade.

    members: (closes, spans) pairs, where spans are the [start, end) calendar ranges in which the stock
    belonged to the group. A stock counts only on days it was a member, so membership can change over time.
    """
    total, count = array('d', [0]) * length, array('I', [0]) * length
    for closes, ranges in members:
        accumulate(total, count, closes, ranges)
    return chain(total, count)


IGNORED_LABELS = ('unclassified', 'others', 'other', 'n/a')


def labels_of(row, taxonomy):
    """The stock's label at each level today; None where it is unclassified."""
    raw = dict(sector=row.get('sector'), industry=row.get('industry'),
               **{key: (taxonomy.get(row['symbol']) or {}).get(key) for key in ('subIndustry', 'theme', 'block', 'macro')})
    cleaned = [(raw.get(level) or '').strip() for level in LEVELS]
    return [label if label and label.lower() not in IGNORED_LABELS else None for label in cleaned]


def record_memberships(ledger, session, labels, eligibility=None):
    """Append today's labels for every stock whose labels changed. The ledger only grows, by date."""
    if not isinstance(ledger, dict) or ledger.get('version') != 1 or list(ledger.get('levels', [])) != list(LEVELS):
        ledger = {'version': 1, 'levels': list(LEVELS), 'records': {}}
    records = ledger['records']
    for symbol in sorted(set(records) | set(labels)):
        current = labels.get(symbol, [None] * len(LEVELS))
        history = records.setdefault(symbol, [])
        if history and history[-1][0] > session:
            raise ValueError('Membership ledger is ahead of this session')
        if not history or history[-1][1] != current:
            if history and history[-1][0] == session:
                history[-1] = [session, current]
            else:
                history.append([session, current])
    if eligibility is not None:
        eligible = ledger.setdefault('eligibility', {})
        for symbol in records:
            current = bool(eligibility.get(symbol, False))
            history = eligible.setdefault(symbol, [])
            if history and history[-1][0] > session:
                raise ValueError('Eligibility ledger is ahead of this session')
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
    starts = [0] + [bisect_left(days, day) for day, _ in history[1:]]
    ends = starts[1:] + [len(days)]
    for (_, labels), start, end in zip(history, starts, ends):
        label = labels[level]
        if label and end > start:
            out.setdefault(label, []).append((start, end))
    return out


def intersect(left, right):
    return [(max(a, c), min(b, d)) for a, b in left for c, d in right if max(a, c) < min(b, d)]


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

    rows: published stock rows; closes: a symbol loader or {symbol: [(date, close), ...]} ascending; benchmarks: {'N50': [...],
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

    rows_by_symbol = {row['symbol']: row for row in rows}
    today = {symbol: labels_of(row, taxonomy) for symbol, row in rows_by_symbol.items()}
    ledger = record_memberships(ledger, session, today,
                                {symbol: group_eligible(row) for symbol, row in rows_by_symbol.items()})
    stocks, shards = [], {name: {frame: {} for frame in frames} for name in ('core', 'rest', 'groups')}
    members, sums = {}, {}
    length = len(composite_days)

    def add(key, values, ranges):
        if not ranges:
            return
        if key not in sums:
            sums[key] = (array('d', [0]) * length, array('I', [0]) * length)
        accumulate(*sums[key], values, ranges)

    # One symbol's raw prices at a time. Historical constituents remain in the ledger after removal.
    for symbol, history in sorted(ledger['records'].items()):
        points = (closes(symbol) if callable(closes) else closes.get(symbol)) or []
        if not points:
            continue
        allowed = spans([(day, [eligible]) for day, eligible in ledger['eligibility'][symbol]], composite_days, 0).get(True, [])
        values = aligned(points, composite_days)
        add('EW', values, allowed)
        for position, level in enumerate(LEVELS):
            for label, ranges in spans(history, composite_days, position).items():
                key = f'{level}:{label}'
                add(key, values, intersect(ranges, allowed))
                if symbol in today and today[symbol][position] == label and ledger['eligibility'][symbol][-1][1]:
                    members.setdefault(key, []).append(symbol)
        row = rows_by_symbol.get(symbol)
        if row is None:
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

    groups = []
    for key, (total, count) in sorted(sums.items()):
        levels = chain(total, count)
        if not any(value is not None for value in levels):
            continue
        points = list(zip(composite_days, levels))
        if key == 'EW':
            benchmarks = dict(benchmarks, EW=points)
            continue
        for frame, coded in series(points).items():
            if coded is not None:
                shards['groups'][frame][key] = coded
        level, label = key.split(':', 1)
        groups.append({'id': key, 'l': level, 'n': label, 'm': sorted(members.get(key, []))})

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
