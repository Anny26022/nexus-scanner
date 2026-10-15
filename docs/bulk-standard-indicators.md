# Bulk daily indicator enrichment

`fetch_advanced_indicators.py` replaces one Dhan indicator request per security
with one TradingView India scanner POST (20-second timeout, one retry). It uses
the existing HTTP helper; no package, login cookie, secret or workflow change
is required.

The payload requests NSE primary stocks, excluding funds, and fetches daily
SMA/EMA 5/10/20/50/100/200 plus RSI14, ATR14, ADX14 and MACD values. The existing
`advanced_indicator_data.json` list/array contract is retained. Rows join to
the master universe by exact ISIN; symbols are never guessed. Missing numeric
values stay null. Partial responses, ambiguous ISINs and column misalignment
fail the fetch. Coverage, unavailable symbols and elapsed time are logged.

Each row retains its source, source candle date, fetch timestamp and update mode.
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

Provider-specific RSI/MACD action labels are not fabricated from numeric values.
These legacy sentiment labels are already excluded from the canonical published
stock artifact. Pivots remain unavailable: the old fetch read only the first Dhan
response element (pivots were in the second), and TradingView's monthly pivots
must not be substituted for daily pivots.

The integration uses the observed scanner interface described by
[tradingview-screener](https://pypi.org/project/tradingview-screener/3.2.2/), not a
guaranteed public API contract. Data use remains subject to the provider's terms.
