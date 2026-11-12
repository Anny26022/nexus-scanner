"""Markets the pipeline publishes, described once each.

A market's spec is what its stages need to know without hard-coding a country: where its sessions are timed, when
they close, what money is counted in, what it is benchmarked against, where its data is published, and which
market-structure features exist there (delivery, F&O, surveillance and circuit bands are Indian; listed options,
ADRs and short interest are American). Shared stages read the spec; market-specific sources live beside it.

India's pipeline predates this module and still carries its own constants; its spec records how it behaves today so
that later stages can move onto it without changing what is published.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class MarketSpec:
    id: str
    name: str
    timezone: ZoneInfo
    session_open: time
    session_close: time
    currency: str
    # Market cap and other amounts as the provider sends them, in units of this many of `currency`.
    provider_amount_unit: float
    # Benchmark for relative strength, as a symbol in this market's universe.
    benchmark: str
    # Root of the market's published files; India keeps the original root.
    publish_prefix: str
    features: frozenset[str]

    def has(self, feature: str) -> bool:
        return feature in self.features


INDIA = MarketSpec(
    id='in', name='India', timezone=ZoneInfo('Asia/Kolkata'), session_open=time(9, 15), session_close=time(15, 30),
    currency='INR', provider_amount_unit=1e7, benchmark='NIFTY 500', publish_prefix='/data',
    features=frozenset({'delivery', 'fno', 'surveillance', 'circuit_bands', 'series', 'promoter_holding', 'bulk_deals'}),
)

UNITED_STATES = MarketSpec(
    id='us', name='United States', timezone=ZoneInfo('America/New_York'), session_open=time(9, 30), session_close=time(16, 0),
    currency='USD', provider_amount_unit=1e6, benchmark='SPY', publish_prefix='/data/us',
    features=frozenset({'listed_options', 'adr', 'short_interest', 'insider_trades', 'sec_filings', 'early_closes'}),
)

MARKETS = {market.id: market for market in (INDIA, UNITED_STATES)}


def market(market_id: str) -> MarketSpec:
    try:
        return MARKETS[market_id]
    except KeyError:
        raise ValueError(f'Unknown market {market_id!r}; known: {", ".join(MARKETS)}') from None
