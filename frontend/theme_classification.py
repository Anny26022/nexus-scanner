"""Resolve the pinned Theme Tracker taxonomy without network calls or AI inference."""
import hashlib
import json
from pathlib import Path

from classification_contract import (catalog_of, canonical_name, listing_age, project_levels,
                                     validate_classification)

SOURCE_PATH = Path(__file__).with_name('theme_tracker_source.json')
WEB_OVERRIDES_PATH = Path(__file__).with_name('theme_tracker_web_overrides.json')
POLICY_PATH = Path(__file__).with_name('classification_policy.json')

# Exact scanner labels provide a transparent, medium-confidence bridge only for
# symbols absent from the pinned Theme Tracker source and issuer overrides.
SCANNER_INDUSTRY_THEMES = {
    ('Aerospace & Defense', 'Engineering'): 'Aerospace & Defense OEM',
    ('Automobiles', 'Auto Components'): 'Auto Ancillaries - Diversified',
    ('Automobiles', 'Auto Dealer'): 'Auto Dealers & Retail',
    ('Automobiles', 'Bikes'): '2/3 Wheelers',
    ('Automobiles', 'Cars & Utility Vehicles'): 'Passenger Cars',
    ('Automobiles', 'Dealers'): 'Auto Dealers & Retail',
    ('Beverages', 'Breweries & Distilleries'): 'Alcoholic Beverages',
    ('Capital Goods', 'Industrial Products'): 'Industrial Products',
    ('Capital Goods', 'Other Electrical Equipment'): 'Electrical Equipment',
    ('Capital Goods', 'Ship Building'): 'Ship Building & Marine',
    ('Capital Markets', 'Stock Broking'): 'Brokerage & Wealth',
    ('Chemicals', 'Commodity Chemicals'): 'Commodity Chemicals',
    ('Chemicals', 'Fertilizers'): 'Fertilizers',
    ('Chemicals', 'Plastics Products'): 'Plastics & Polymers',
    ('Chemicals', 'Specialty Chemicals'): 'Speciality Chemicals',
    ('Chemicals', 'Trading Chemicals'): 'Commodity Trading',
    ('Commercial Services', 'Consulting Services'): 'BPO & Specialized Services',
    ('Commercial Services', 'Diversified Services'): 'BPO & Specialized Services',
    ('Commercial Services', 'Trading & Distributors'): 'General Trading & Dist.',
    ('Construction', 'Cement'): 'Cement',
    ('Construction', 'Civil Construction'): 'Civil Construction EPC',
    ('Consumer Goods', 'Cigarettes & Tobacco'): 'Cigarettes & Tobacco',
    ('Consumer Goods', 'Diversified Products'): 'Packaged Diversified FMCG',
    ('Consumer Goods', 'Granites & Marbles'): 'Tiles',
    ('Consumer Goods', 'Jewellery & Watches'): 'Jewellery',
    ('Consumer Goods', 'Leather Products'): 'Footwear & Leather',
    ('Consumer Goods', 'Sugar'): 'Sugar',
    ('Consumer Goods', 'Tea & Coffee'): 'Tea & Coffee',
    ('Consumer Services', 'Education'): 'Education & E-Learning',
    ('Diversified', 'Diversified Group'): 'Diversified Conglomerates',
    ('FMCG', 'Agricultural Products'): 'Animal Feed & Seeds',
    ('FMCG', 'FMCG Products'): 'Packaged Diversified FMCG',
    ('Financial Services', 'Holding Company'): 'Investment & Holding',
    ('Financial Services', 'NBFC'): 'NBFC',
    ('Financial Services', 'Other Financial Services'): 'Financial Institutions',
    ('Food Products', 'Animal Feed'): 'Animal Feed & Seeds',
    ('Food Products', 'Dairy Products'): 'Dairy & Milk Products',
    ('Food Products', 'Packaged Foods'): 'Packaged & Processed Foods',
    ('Food Products', 'Seafood'): 'Seafood & Meat',
    ('Forest Materials', 'Forest Products'): 'Wood & Plywood',
    ('Forest Materials', 'Paper & Paper Products'): 'Stationery & Paper',
    ('Healthcare', 'Biotechnology'): 'Pharma',
    ('Healthcare', 'Healthcare Technology'): 'Specialized Equipment & Retail',
    ('Healthcare', 'Medical Equipment'): 'Specialized Equipment & Retail',
    ('Healthcare', 'Pharmaceuticals'): 'Pharma',
    ('Industrial Products', 'Aluminium Copper & Zinc'): 'Copper & Specialty Metallurgy',
    ('Industrial Products', 'Electrodes & Refractories'): 'Refractories',
    ('Industrial Products', 'Iron & Steel Products'): 'Iron & Steel Products',
    ('Industrial Products', 'Other Industrial Products'): 'Industrial Products',
    ('Industrial Products', 'Packaging'): 'Packaging',
    ('Industrial Products', 'Plastic Products - Industrial'): 'Plastics & Polymers',
    ('Information Technology', 'Computer Software & Consulting'): 'IT Services (Consulting)',
    ('Information Technology', 'IT Enabled Services'): 'IT Enabled Services',
    ('Information Technology', 'Software Products'): 'IT Products',
    ('Leisure Services', 'Hotels & Resorts'): 'Hotels & Resorts',
    ('Leisure Services', 'Recreation'): 'Leisure & Amusement',
    ('Logistics & Cargo', 'Logistics Solution Provider'): 'Logistics',
    ('Media', 'Electronic Media'): 'Electronic Media & News',
    ('Media', 'Media & Entertainment'): 'Media & Entertainment',
    ('Metals & Mining', 'Aluminium'): 'Aluminium & Base Metals',
    ('Metals & Mining', 'Industrial Minerals'): 'Industrial Minerals',
    ('Metals & Mining', 'Iron & Steel'): 'Iron & Steel Core',
    ('Metals & Mining', 'Non - Ferrous Metals'): 'Aluminium & Base Metals',
    ('Metals & Mining', 'Trading Metals'): 'Commodity Trading',
    ('Realty', 'Real Estate Services'): 'Real Estate Services & Platforms',
    ('Realty', 'Residential Commercial Projects'): 'Residential Projects',
    ('Retail', 'Distributors'): 'General Trading & Dist.',
    ('Textiles', 'Cotton/Blended'): 'Spinning & Yarn Processing',
    ('Textiles', 'Spinning - Synthetic / Blended'): 'Spinning & Yarn Processing',
    ('Textiles', 'Textile Processing'): 'Spinning & Yarn Processing',
    ('Textiles', 'Textile Products'): 'Home Textiles & Furnish',
    ('Textiles', 'Textile Trading'): 'General Trading & Dist.',
    ('Textiles', 'Textiles & Apparels'): 'Readymade Garments/ Apparells',
    ('Utilities', 'Waste Management'): 'Waste Management',
}


def consolidated_classification(stocks, taxonomy):
    """Export primary taxonomy and thematic detail without conflating industries."""
    return {
        'schemaVersion': taxonomy['schemaVersion'], 'asOfDate': taxonomy['asOfDate'],
        'themeVersion': taxonomy['version'], 'totalStocks': len(stocks),
        'records': {stock['symbol']: {
            'name': stock.get('name'), 'sector': stock.get('sector'),
            'basicIndustry': stock.get('industry'),
            'providerSector': stock.get('providerSector'),
            'providerIndustry': stock.get('providerIndustry'),
            'nicheTags': stock.get('nicheTags', []),
            'nicheEvidence': stock.get('nicheEvidence'),
            'thematic': taxonomy['records'][stock['symbol']],
        } for stock in sorted(stocks, key=lambda row: row['symbol'])},
    }


def classify(stocks, as_of, source_path=SOURCE_PATH):
    raw = source_path.read_bytes()
    source = json.loads(raw)
    overrides_raw = WEB_OVERRIDES_PATH.read_bytes()
    overrides = json.loads(overrides_raw)['assignments']
    policy_raw = POLICY_PATH.read_bytes()
    policy = json.loads(policy_raw)
    nodes = catalog_of(source, policy)
    source_symbols = [row[0] for row in source['rows']]
    if any(len(row) != len(source['fields']) for row in source['rows']):
        raise ValueError('Invalid Theme Tracker row shape')
    if len(source_symbols) != len(set(source_symbols)):
        raise ValueError('Theme Tracker source contains duplicate symbols')
    source_rows = {row[0]: dict(zip(source['fields'], row)) for row in source['rows']}
    themes = {theme['name']: theme for block in source['blocks'] for theme in block['themes']}
    referenced = {row.get('theme') for row in source_rows.values() if row.get('theme')}
    referenced |= {name for row in source_rows.values() for name in row.get('curatedThemes') or []}
    referenced |= {item['theme'] for item in overrides.values()} | set(SCANNER_INDUSTRY_THEMES.values())
    referenced |= {item['theme'] for item in policy['primaryOverrides'].values()}
    referenced |= {name for item in policy['primaryOverrides'].values() for name in item.get('memberships', [])}
    referenced |= {name for decisions in policy['overlapDecisions'].values() for name in decisions}
    if referenced - set(nodes):
        raise ValueError(f'Unknown classification themes: {sorted(referenced - set(nodes))}')
    if any(nodes[item['theme']]['kind'] not in ('business', 'aggregate') for item in policy['primaryOverrides'].values()):
        raise ValueError('A primary classification must identify a business, not an exposure or cohort')
    if len({stock['symbol'] for stock in stocks}) != len(stocks):
        raise ValueError('Scanner snapshot contains duplicate symbols')
    records, unmapped = {}, []
    for stock in sorted(stocks, key=lambda row: row['symbol']):
        symbol = stock['symbol']
        row = source_rows.get(symbol, {})
        identity = policy.get('securityAliases', {}).get(symbol)
        if not row and identity and as_of >= identity['effectiveFrom']:
            row = source_rows.get(identity['sourceSymbol'], {})
        reviewed = policy['primaryOverrides'].get(symbol)
        web_override = overrides.get(symbol)
        memberships = {}
        primary = None

        def assign(name, basis):
            name = canonical_name(name, nodes)
            if name and nodes[name]['kind'] not in ('cohort', 'alias'):
                memberships.setdefault(name, basis)
            return name

        # Primary selection is independent of supplemental edges and JSON ordering.
        if reviewed:
            primary = assign(reviewed['theme'], 'reviewed-business')
        elif row.get('theme') and nodes[row['theme']]['kind'] in ('business', 'aggregate', 'alias'):
            primary = assign(row['theme'], row.get('provenance') or 'production-public-asset')
        if primary is None:
            explicit = sorted(name for name, theme in themes.items()
                              if not theme.get('mirrorOf') and nodes[name]['kind'] == 'business'
                              and symbol in theme.get('symbols', []))
            industry = sorted(name for name, theme in themes.items()
                              if not theme.get('mirrorOf') and nodes[name]['kind'] == 'business'
                              and row.get('industry') in theme.get('industries', []))
            if explicit:
                primary = assign(explicit[0], 'curated-rule')
            elif industry:
                primary = assign(industry[0], 'derived-rule')
            elif web_override:
                primary = assign(web_override['theme'], 'web-research')
            else:
                primary = assign(SCANNER_INDUSTRY_THEMES.get((
                    stock.get('providerSector', stock.get('sector')),
                    stock.get('providerIndustry', stock.get('industry')))), 'scanner-industry-bridge')

        for name in row.get('curatedThemes') or []:
            assign(name, 'curated-rule')
        for name in (reviewed or {}).get('memberships', []):
            assign(name, 'reviewed-business')
        for name, decision in policy['overlapDecisions'].get(symbol, {}).items():
            if decision['include']:
                assign(name, 'reviewed-overlap')
            else:
                # A review can retire an imported secondary edge, but never erase the primary.
                rejected = canonical_name(name, nodes)
                if rejected != primary:
                    memberships.pop(rejected, None)
        # Only reviewed cross-business edges supplement the explicit primary.
        # Broad or obsolete symbol lists remain audit candidates, never implicit exposures.
        cohorts = {}
        sessions = (stock.get('metrics') or {}).get('historySessions')
        age = listing_age(stock.get('listingDate'), as_of)
        rule = policy['cohorts']['IPO / Young Bases']
        if (isinstance(sessions, (int, float)) and not isinstance(sessions, bool)
                and 1 <= sessions <= rule['maxHistorySessions']
                and age is not None and age <= rule['maxListingDays']):
            cohorts['IPO / Young Bases'] = 'listing-age-and-history'
        if primary is None:
            unmapped.append(symbol)
        def matches(name):
            node = nodes[name]
            return name in memberships or any(matches(parent) for parent in node['targets'])
        aliases = sorted(name for name, node in nodes.items() if node['kind'] == 'alias' and matches(name))
        basis = memberships.get(primary)
        evidence = reviewed if basis == 'reviewed-business' else web_override if basis == 'web-research' else None
        record = {
            'theme': primary,
            'block': nodes[primary]['block'] if primary else None,
            'macro': nodes[primary]['macro'] if primary else None,
            # Retained for old clients; sourceIndustry names its actual authority.
            'industry': row.get('industry'), 'sourceIndustry': row.get('industry'),
            'sourceSymbol': row.get('symbol'),
            'subIndustry': (reviewed or {}).get('subIndustry', row.get('sub_industry')),
            'sourceSubIndustry': row.get('sub_industry'),
            'memberships': memberships, 'cohorts': cohorts, 'aliases': aliases,
            'mappingSpecificity': 'broad' if primary and nodes[primary]['kind'] == 'aggregate' else 'specific' if primary else None,
            'mappingConfidence': (evidence.get('confidence', 'high') if evidence else
                                  'medium' if basis == 'scanner-industry-bridge' else 'source' if primary else None),
            'mappingEvidenceUrl': evidence.get('sourceUrl') if evidence else None,
            'issuerOverlay': ({'niche': web_override['niche'], 'confidence': web_override['confidence'],
                              'sourceUrl': web_override['sourceUrl']} if web_override and web_override.get('niche') else None),
        }
        record['levels'] = project_levels(record, nodes)
        record['availability'] = {level: bool(primary) for level in ('theme', 'block', 'macro', 'aggregate')}
        record['availability']['subIndustry'] = bool(record['subIndustry'])
        record['availability']['cohort'] = age is not None and (age > rule['maxListingDays'] or
            isinstance(sessions, (int, float)) and not isinstance(sessions, bool) and sessions >= 1)
        records[symbol] = record
    version = hashlib.sha256(raw + overrides_raw + policy_raw + Path(__file__).read_bytes()
                             + Path(__file__).with_name('classification_contract.py').read_bytes()).hexdigest()
    result = {'schemaVersion': 2, 'version': version, 'asOfDate': as_of,
              'source': source['source'], 'nodes': nodes, 'records': records,
              'coverage': {'total': len(records), 'mapped': len(records) - len(unmapped),
                           'unmapped': unmapped, 'cohortMembers': sum(bool(r['cohorts']) for r in records.values())}}
    validate_classification(stocks, result)
    return result
