"""Which of Dhan's US listings are screenable stocks.

Dhan lists every exchange-traded security under `OgInst=ES`, so the stock list also holds preferred shares, notes,
rights, warrants and SPAC units. Dhan names the share class after a " - " (`Alphabet (Google) - Preferred Stock -
...`, `Churchill Capital XI - Units`). "Units" alone is ambiguous: partnerships trade as units too (`KKR - Units`,
`Plains GP - Units - Class A`) and are ordinary equity for screening; SPAC units carry a five-letter symbol ending in U.

Dhan's stock list also carries some funds (ProShares' leveraged SpaceX ETF, buffer and covered-call ETFs, and rows
whose name is a company's but whose data is a fund's): their Sector is a fund category ('Trading--Leveraged Equity',
'Large Blend', 'Defined Outcome'), never one of the stock sectors, so they are classified as funds.

Each row gets a `security_type`; the screener keeps common stock and partnership units. The rest stay classified (not
silently lost) so later phases can offer them as their own filters.
"""

from __future__ import annotations

import re

SCREENABLE = frozenset({'common', 'partnership_unit'})
_DESCRIPTOR = re.compile(r'\s-\s(Preferred Stock|Notes?|Debentures?|Rights?|Warrants?|Units?)\b', re.I)
_KIND = {'preferred stock': 'preferred', 'note': 'note', 'notes': 'note', 'debenture': 'note', 'debentures': 'note',
         'right': 'right', 'rights': 'right', 'warrant': 'warrant', 'warrants': 'warrant'}
# Dhan's (Morningstar's) stock sectors; any other sector is a fund category.
STOCK_SECTORS = frozenset({'Basic Material', 'Basic Materials', 'Communication Services', 'Consumer Cyclical',
                           'Consumer Defensive', 'Energy', 'Financial Services', 'Healthcare', 'Industrials',
                           'Real Estate', 'Technology', 'Utilities', 'Unclassified'})


def security_type(symbol: str, name: str | None, sector: str | None = None) -> str:
    label = (sector or '').strip()  # a blank sector, however it is spelled, says nothing about the row
    if label and label not in STOCK_SECTORS:
        return 'fund'
    match = _DESCRIPTOR.search(name or '')
    if not match:
        return 'common'
    kind = match.group(1).lower()
    if kind.startswith('unit'):
        return 'spac_unit' if len(symbol) == 5 and symbol.endswith('U') else 'partnership_unit'
    return _KIND[kind]


# Listing exchanges the history service accepts, tried in order for the few rows Dhan leaves unlabelled ("NA").
FALLBACK_EXCHANGES = ('NYSE', 'NASDAQ')


def history_exchanges(listing_exchange: str | None) -> tuple[str, ...]:
    return (listing_exchange,) if listing_exchange and listing_exchange != 'NA' else FALLBACK_EXCHANGES
