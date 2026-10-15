# Bulk daily indicator enrichment

`fetch_advanced_indicators.py` replaces one Dhan indicator request per security
with one TradingView India scanner POST (20-second timeout, one retry). It uses
the existing HTTP helper; no package, login cookie, secret or workflow change
is required.

The payload requests NSE primary stocks, excluding funds, and fetches daily
SMA/EMA 5/9/10/20/21/50/100/150/200 plus RSI14, ATR14, ADX14 and MACD values. The existing
`advanced_indicator_data.json` list/array contract is retained. Rows join to
the master universe by exact ISIN; symbols are never guessed. Missing numeric
values stay null. Partial responses, ambiguous ISINs and column misalignment
fail the fetch. Coverage, unavailable symbols and elapsed time are logged.

Each row retains its source, source candle date, fetch timestamp and update mode.
It also requests `exchange` and `is_primary`, retaining the qualified TradingView
symbol and primary exchange. A row is accepted only when its exchange is NSE
and `is_primary` is exactly true. Therefore `primaryExchange: NSE` is derived
from verified listing metadata, not guessed from the canonical symbol. The
daily universe remains NSE primary stocks; it does not add BSE-only listings.
Only the latest observed session in the matched stock universe is retained;
the machine's calendar date is not used as the market session. A date describes
the provider candle, not proof that the market has closed; unauthenticated
TradingView quotes may be delayed. This enrichment does not overwrite canonical
OHLCV, financials or snapshot indicators.

Scanner SMA/EMA, persistence counters, patterns, exact return windows, turnover
and RS still use the existing date-aligned history engine. This PR removes the
per-security enrichment fan-out, not the historical fetch or snapshot calculation
stage. Formula parity has not been established, so TradingView values are not
silently substituted into those calculations.

The same request also collects OHLC/volume, change/gap, VWAP, 52-week/all-time
extremes, calendar-period performance, ADR14/ATR14 percentages, market cap, float,
30-day average volume and 10/30/60/90-day average traded value, plus financial ratios/statements. Annual,
TTM and current financial fields keep their period in the mapped name. INR
amounts are converted to crore once; non-INR sections remain unavailable.
`tradingview_fields.json` is the shared registry for all 81 numeric fields and
their wire keys, labels, units, categories and divisors. The seven remaining
requested fields carry identity, listing, timing and currency metadata. The registry is
included in pipeline wheels and immutable snapshot revision hashing.
TradingView `relative_volume_10d_calc` is retained as `market.rvol10` without unit
conversion. It is distinct from Nexus's existing preceding-20-session RVOL.
Performance fields cover 5D, 1W, 1M, 3M, 6M, 1Y, YTD, 3Y, 5Y, 10Y and all time.
Percentage values are retained as returned, including negatives and nulls.

Expanded technical/market/financial data is retained as `tradingview_snapshot` in the
canonical backend stock artifact, with its own source and candle/fetch dates.
Daily publication carries date-aligned fields into `stocks.json`, its gzip and
packed variants under `tradingview`, with `tradingViewMetricsVersion: 1`.
It is not substituted into existing frontend fields or financial history:
the observation date does not establish a financial statement's reporting date,
and calendar-period returns are not our exact trading-session return windows.
There is no new historical ledger. Unsupported
20/50/100-day average traded-value keys are not requested.

In Custom Filters, the existing Technicals, Momentum & Volume, Market & Liquidity
and Fundamentals tabs each gain one TradingView metric selector using the shared
editor. Select a named metric, comparison and threshold; Add rule supports
multiple metrics combined through the existing AND/OR logic. The units and
annual/TTM/performance window remain explicit in the metric name. Optional
`TV ...` result columns display the same values. No browser request to TradingView
is made: screens evaluate the immutable daily CDN snapshot.

Selectors are offered only when the loaded release contains populated, aligned
source values. Missing or stale values stay unavailable, including under negation.
Saved TradingView filters against an older release report that a newer daily
dataset is required. Merge/deploy and the next successful normal pipeline run
publish the data needed to use the new filters; no manual scrape is required.

The request is an explicit selection, not the entire TradingView catalogue.
A further live audit confirmed average volume 10/60/90,
SMA/EMA30, RSI7, Stochastic and Stochastic RSI K/D, CCI20, Williams %R, Momentum,
ROC, Awesome Oscillator, ADX +/-DI, Bollinger basis/upper/lower, quarterly
revenue/net income, annual operating/investing/financing cash flow and equity.
These are candidates for later mappings, not collected production fields.
Quarterly revenue had only 1,019 populated values across 3,183 NSE stocks in
that probe; a catalogue entry is not proof of complete coverage or formula parity.

Provider-specific RSI/MACD action labels are not fabricated from numeric values.
These legacy sentiment labels are already excluded from the canonical published
stock artifact. Pivots remain unavailable: the old fetch read only the first Dhan
response element (pivots were in the second), and TradingView's monthly pivots
must not be substituted for daily pivots.

The integration uses the observed scanner interface described by
[tradingview-screener](https://pypi.org/project/tradingview-screener/3.2.2/), not a
guaranteed public API contract. Data use remains subject to the provider's terms.
