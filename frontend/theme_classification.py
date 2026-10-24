"""Resolve the pinned Theme Tracker taxonomy without network calls or AI inference."""
import hashlib
import json
from pathlib import Path

SOURCE_PATH = Path(__file__).with_name('theme_tracker_source.json')
WEB_OVERRIDES_PATH = Path(__file__).with_name('theme_tracker_web_overrides.json')

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
    ('Forest Materials', 'Forest Products'): 'Paper & Packaging',
    ('Forest Materials', 'Paper & Paper Products'): 'Stationery & Paper',
    ('Healthcare', 'Biotechnology'): 'Pharma (Biotech & CRAMS)',
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
        'schemaVersion': 1, 'asOfDate': taxonomy['asOfDate'],
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
    overrides_path = WEB_OVERRIDES_PATH
    overrides_raw = overrides_path.read_bytes()
    overrides = json.loads(overrides_raw)['assignments']
    source_symbols = [row[0] for row in source['rows']]
    if len(source_symbols) != len(set(source_symbols)):
        raise ValueError('Theme Tracker source contains duplicate symbols')
    source_rows = {row[0]: dict(zip(source['fields'], row)) for row in source['rows']}
    themes = {theme['name']: dict(theme, block=block['title'])
              for block in source['blocks'] for theme in block['themes']}
    if len(themes) != sum(len(block['themes']) for block in source['blocks']):
        raise ValueError('Theme Tracker source contains duplicate theme names')
    unknown_override_themes = sorted({item['theme'] for item in overrides.values()} - set(themes))
    if unknown_override_themes:
        raise ValueError(f'Unknown override themes: {", ".join(unknown_override_themes)}')
    unknown_bridge_themes = sorted(set(SCANNER_INDUSTRY_THEMES.values()) - set(themes))
    if unknown_bridge_themes:
        raise ValueError(f'Unknown bridge themes: {", ".join(unknown_bridge_themes)}')
    stock_symbols = [stock['symbol'] for stock in stocks]
    if len(stock_symbols) != len(set(stock_symbols)):
        raise ValueError('Scanner snapshot contains duplicate symbols')
    macros = {block: macro['title'] for macro in source['macros'] for block in macro['blocks']}
    records, unmapped = {}, []
    for stock in sorted(stocks, key=lambda row: row['symbol']):
        symbol = stock['symbol']
        # Scanner symbols are security-master identities; never fuzzy-match names.
        row = source_rows.get(symbol, {})
        memberships = {}

        def assign(name, basis):
            theme = themes.get(name)
            if not theme or name in memberships:
                return
            if memberships and not theme.get('allowMultipleMembership'):
                return
            memberships[name] = basis

        assign(row.get('theme'), row.get('provenance') or 'production-public-asset')
        for name in row.get('curatedThemes') or []:
            assign(name, 'curated-rule')
        # Young IPO cohort: any stock trading for 100 sessions or fewer
        history_sessions = (stock.get('metrics') or {}).get('historySessions')
        if history_sessions is not None and 1 <= history_sessions <= 100:
            assign('IPO / Young Bases', 'curated-rule')
        # Preserve Tracker priority: canonical, curated, explicit symbols, industries.
        for name, theme in themes.items():
            if not theme.get('mirrorOf') and symbol in theme.get('symbols', []):
                assign(name, 'curated-rule')
        for name, theme in themes.items():
            if not theme.get('mirrorOf') and row.get('industry') in theme.get('industries', []):
                assign(name, 'derived-rule')
        web_override = overrides.get(symbol)
        if not memberships and web_override:
            assign(web_override['theme'], 'web-research')
        if not memberships:
            bridge_theme = SCANNER_INDUSTRY_THEMES.get((stock.get('providerSector', stock.get('sector')),
                                                      stock.get('providerIndustry', stock.get('industry'))))
            if bridge_theme:
                assign(bridge_theme, 'scanner-industry-bridge')
        # Mirror groups are aliases/aggregations, not extra business exposures.
        def matches(name, visiting):
            if name in memberships:
                return True
            if name in visiting:
                return False
            mirror = themes.get(name, {}).get('mirrorOf', [])
            return any(matches(parent, visiting | {name}) for parent in ([mirror] if isinstance(mirror, str) else mirror))

        aliases = [name for name, theme in themes.items() if theme.get('mirrorOf') and matches(name, set())]
        primary = next(iter(memberships), None)
        if primary is None:
            unmapped.append(symbol)
        overlay = ({
            'niche': web_override['niche'],
            'confidence': web_override['confidence'],
            'sourceUrl': web_override['sourceUrl'],
        } if web_override and web_override.get('niche') else None)
        records[symbol] = {
            'theme': primary,
            'block': themes[primary]['block'] if primary else None,
            'macro': macros.get(themes[primary]['block']) if primary else None,
            'industry': row.get('industry'),
            'subIndustry': row.get('sub_industry'),
            'memberships': memberships,
            'aliases': aliases,
            'mappingConfidence': (web_override.get('confidence') if primary and memberships.get(primary) == 'web-research' and web_override
                                  else 'medium' if primary and memberships.get(primary) == 'scanner-industry-bridge'
                                  else 'source' if primary else None),
            'mappingEvidenceUrl': web_override.get('sourceUrl') if primary and memberships.get(primary) == 'web-research' and web_override else None,
            'issuerOverlay': overlay,
        }
    version = hashlib.sha256(raw + overrides_raw + Path(__file__).read_bytes()).hexdigest()
    return {'schemaVersion': 1, 'version': version, 'asOfDate': as_of,
            'source': source['source'], 'records': records,
            'coverage': {'total': len(records), 'mapped': len(records) - len(unmapped), 'unmapped': unmapped}}
