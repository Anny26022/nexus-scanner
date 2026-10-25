"""Shared publication contract for business classifications, exposures and cohorts."""
from datetime import date, datetime

LEVELS = ('sector', 'industry', 'subIndustry', 'theme', 'block', 'macro', 'cohort', 'aggregate')
MISSING_LABELS = frozenset(('', 'unclassified', 'other', 'others', 'n/a', 'none', 'null'))


def clean_label(value):
    value = value.strip() if isinstance(value, str) else ''
    return value if value.lower() not in MISSING_LABELS else None


def listing_age(value, session):
    if not isinstance(value, str):
        return None
    for pattern in ('%Y-%m-%d', '%d-%b-%Y'):
        try:
            days = (date.fromisoformat(session) - datetime.strptime(value, pattern).date()).days
            return days if days >= 0 else None
        except ValueError:
            continue
    return None


def review_primary_classifications(stocks, policy):
    """Apply the same exact-label normalization and explicit issuer reviews to every projection."""
    rows = []
    for stock in stocks:
        row = dict(stock)
        row['sector'] = policy['sectorAliases'].get(row.get('sector'), row.get('sector'))
        reviewed = policy.get('reviewedOverrides', {}).get(row['symbol'])
        if reviewed:
            row.update(sector=reviewed['sector'], industry=reviewed['industry'])
        rows.append(row)
    return rows


def project_company_classifications(records, stocks):
    companies = {stock['symbol']: stock for stock in stocks}
    return [{**record, **{key: companies[record['symbol']][key] for key in ('sector', 'industry')}}
            if record.get('symbol') in companies else record for record in records]


def catalog_of(source, policy):
    """Validate the entire graph before resolving any stock."""
    macros = {}
    block_names = [b['title'] for b in source['blocks']]
    if len(block_names) != len(set(block_names)):
        raise ValueError('Duplicate thematic blocks')
    for macro in source['macros']:
        for block in macro['blocks']:
            if block not in block_names or block in macros:
                raise ValueError(f'Invalid or duplicate macro parent: {block}')
            macros[block] = macro['title']
    for block, reviewed in policy.get('macroParents', {}).items():
        if block not in block_names:
            raise ValueError(f'Unknown reviewed macro block: {block}')
        macros[block] = reviewed['macro']
    nodes = {}
    for block in source['blocks']:
        for theme in block['themes']:
            name = theme['name']
            if name in nodes:
                raise ValueError('Theme Tracker source contains duplicate theme names')
            mirror = policy.get('mirrorOverrides', {}).get(name, theme.get('mirrorOf', []))
            targets = [mirror] if isinstance(mirror, str) else mirror
            parent = policy['themeParents'].get(name, block['title'])
            kind = ('cohort' if name in policy['cohorts'] else 'exposure' if name in policy['themeParents']
                    else 'aggregate' if len(targets) > 1 else 'alias' if targets else 'business')
            nodes[name] = {'id': policy['nodes'][name]['id'], 'kind': kind,
                           'enabled': policy['cohorts'].get(name, {}).get('enabled', True),
                           'block': None if kind == 'cohort' else parent,
                           'macro': macros.get(parent) if kind != 'cohort' else None,
                           'targets': targets}
    for theme in policy.get('additionalThemes', []):
        name = theme['name']
        if name in nodes or theme['block'] not in block_names:
            raise ValueError('Invalid additional classification node')
        nodes[name] = {'id':policy['nodes'][name]['id'], 'kind':'aggregate', 'enabled':True, 'block':theme['block'],
                       'macro':macros.get(theme['block']), 'targets':theme['targets']}
    if set(policy.get('mirrorOverrides', {})) - set(nodes):
        raise ValueError('Unknown reviewed mirror')
    if set(nodes) != set(policy['nodes']) or len({n['id'] for n in nodes.values()}) != len(nodes):
        raise ValueError('Classification node registry mismatch')
    for node in nodes.values():
        if any(target not in nodes for target in node['targets']):
            raise ValueError('Unknown classification mirror target')
    def visit(name, visiting):
        if name in visiting:
            raise ValueError('Classification mirror cycle')
        for target in nodes[name]['targets']:
            visit(target, visiting | {name})
    for name in nodes:
        visit(name, set())
    for name, parent in policy['themeParents'].items():
        if name not in nodes or parent not in macros:
            raise ValueError(f'Invalid exposure parent: {name}')
    return nodes


def canonical_name(name, nodes):
    if name not in nodes:
        return None
    while nodes[name]['kind'] == 'alias':
        name = nodes[name]['targets'][0]
    return name


def project_levels(record, nodes):
    """Expand aggregates for theme lookup; parents come from actual exposure edges."""
    direct = set(record['memberships'])
    themes = set(direct)
    changed = True
    while changed:
        changed = False
        for name, node in nodes.items():
            if node['kind'] == 'aggregate' and name not in themes and any(
                    canonical_name(target, nodes) in themes for target in node['targets']):
                themes.add(name)
                changed = True
    return {
        'subIndustry': [record['subIndustry']] if clean_label(record.get('subIndustry')) else [],
        'theme': sorted(direct),
        'block': sorted({nodes[name]['block'] for name in direct if nodes[name]['block']}),
        'macro': sorted({nodes[name]['macro'] for name in direct if nodes[name]['macro']}),
        'cohort': sorted(record['cohorts']),
        'aggregate': sorted(name for name in themes if nodes[name]['kind'] == 'aggregate'),
    }


def group_labels(stock, record, level):
    """Both old releases and the v2 publisher use this exact membership projection."""
    if level in ('sector', 'industry'):
        value = clean_label(stock.get(level))
        return [value] if value else []
    if 'levels' in record:
        return sorted({label for item in record['levels'].get(level, []) if (label := clean_label(item))})
    if level == 'theme':
        return sorted({label for item in [record.get('theme'), *(record.get('memberships') or {})]
                       if item != 'IPO / Young Bases' and (label := clean_label(item))})
    if level == 'cohort':
        return ['IPO / Young Bases'] if (record.get('theme') == 'IPO / Young Bases'
                                        or 'IPO / Young Bases' in (record.get('memberships') or {})) else []
    if level in ('block', 'macro') and record.get('theme') == 'IPO / Young Bases':
        return []
    value = clean_label(record.get(level))
    return [value] if value else []


def validate_classification(stocks, taxonomy, consolidated=None):
    symbols = {stock['symbol'] for stock in stocks}
    if symbols != set(taxonomy['records']) or len(symbols) != len(stocks):
        raise ValueError('Classification security universe mismatch')
    if consolidated is not None:
        if (consolidated['themeVersion'] != taxonomy['version'] or
                consolidated['asOfDate'] != taxonomy['asOfDate'] or
                set(consolidated['records']) != symbols or
                any(row['thematic'] != taxonomy['records'][symbol]
                    for symbol, row in consolidated['records'].items())):
            raise ValueError('Classification projections disagree')
        if taxonomy['schemaVersion'] == 2 and any(
                (consolidated['records'][stock['symbol']].get('sector'),
                 consolidated['records'][stock['symbol']].get('basicIndustry')) !=
                (stock.get('sector'), stock.get('industry')) for stock in stocks):
            raise ValueError('Primary company classification projections disagree')
    nodes = taxonomy.get('nodes', {})
    for record in taxonomy['records'].values():
        if taxonomy['schemaVersion'] == 2:
            if record['theme'] and record['theme'] not in record['memberships']:
                raise ValueError('Primary theme must be a business membership')
            if any(nodes[name]['kind'] in ('alias', 'cohort') for name in record['memberships']):
                raise ValueError('Aliases and cohorts cannot be business memberships')
            if record['levels'] != project_levels(record, nodes):
                raise ValueError('Invalid classification group projection')


def validate_classification_release(output, manifest):
    """Gate publication on the bytes being activated, not just in-memory inputs."""
    if not manifest.get('themeClassificationVersion'):
        return
    import gzip
    import json
    generation = output / 'revisions' / manifest['revision']
    taxonomy = json.loads(gzip.decompress((generation / 'theme-classification.json.gz').read_bytes()))
    consolidated = json.loads((generation / 'universe-classification.json').read_text())
    stocks = json.loads(gzip.decompress((generation / 'stocks.json.gz').read_bytes()))
    if (taxonomy['version'] != manifest['themeClassificationVersion'] or
            taxonomy['asOfDate'] != manifest['sessionDate'] or stocks['revision'] != manifest['revision'] or
            stocks['asOfDate'] != manifest['sessionDate'] or len(stocks['stocks']) != manifest['totalStocks'] or
            manifest.get('classificationSchemaVersion', taxonomy['schemaVersion']) != taxonomy['schemaVersion']):
        raise ValueError('Classification release binding mismatch')
    if taxonomy['schemaVersion'] == 2 and stocks.get('classificationVersion') != taxonomy['version']:
        raise ValueError('Snapshot classification version mismatch')
    validate_classification(stocks['stocks'], taxonomy, consolidated)
    if taxonomy['schemaVersion'] == 2:
        companies = {stock['symbol']: stock for stock in stocks['stocks']}
        directory = json.loads(gzip.decompress((generation / 'chart-directory.json.gz').read_bytes()))
        if (directory['revision'] != manifest['revision'] or
                {row['symbol'] for row in directory['stocks']} != set(companies) or
                any((row['sector'], row['industry']) != (companies[row['symbol']]['sector'], companies[row['symbol']]['industry'])
                    for row in directory['stocks'])):
            raise ValueError('Chart directory classifications disagree')
        ipo_path = output.parent / manifest['iposUrl'].lstrip('/')
        # The staged publisher writes the same revision-local file before activation.
        ipo_path = generation / 'ipos.json.gz' if (generation / 'ipos.json.gz').exists() else ipo_path
        ipos = json.loads(gzip.decompress(ipo_path.read_bytes()))
        if any((row.get('sector'), row.get('industry')) !=
               (companies[row['symbol']]['sector'], companies[row['symbol']]['industry'])
               for row in ipos['records'] if row.get('symbol') in companies):
            raise ValueError('IPO classifications disagree')
