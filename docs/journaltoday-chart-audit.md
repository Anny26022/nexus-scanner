# JournalToday public chart audit — 15 October 2026

Requested reference: https://journaltoday.org/screener. Fetched its HTML and
public module dependencies with curl; no authentication or access controls were
bypassed. No REA tool was available in this session; direct public-bundle inspection
was sufficient for the facts below. Minified source was read, not executed or
copied into Nexus. Downloaded research files remain outside the repository.

## Verified public modules (site release v1.0.43)

- [Entry](https://journaltoday.org/assets/v1.0.43/index-B_gTMwtk.js)
- [Screener page](https://journaltoday.org/assets/v1.0.43/StockScreenerPage-BzSpKVZI.js)
- [Shared watchlist/screener chart](https://journaltoday.org/assets/v1.0.43/WatchlistChart-YbD2BRa3.js)
- [Replay chart](https://journaltoday.org/assets/v1.0.43/ReplayChart-CMu2i62s.js)
- [Lightweight Charts dependency](https://journaltoday.org/assets/v1.0.43/lightweight-charts.production-DId5_vD6.js)

The screener imports the shared watchlist chart. That module uses Lightweight
Charts plus custom indicator definitions, drawing primitives, preference storage,
markers and application UI. It is not the TradingView Advanced Charts widget.

## EMA defaults and styling

| Setting | Shared screener/watchlist chart | Replay chart |
| --- | --- | --- |
| EMA9 | Amber `#f59e0b`, enabled | Same color, disabled |
| EMA20 | Purple `#8b5cf6`, enabled | Same color, enabled |
| EMA50 | Cyan `#22d3ee`, disabled | Same color, disabled |
| Styling | Editable periods, color, opacity/brightness, width, line style | Editable periods, color, brightness, line style; line width 2 |

The shared chart stores indicator layouts and EMA preferences. Its plot
definitions use two-pixel moving-average lines. The public chart configuration
also supports independently toggled horizontal/vertical grids, a normal
crosshair, separate volume scaling, price-axis interactions and a time-axis
right offset. These are application settings, not a license to redistribute the
application's implementation.

## Indicator catalog observed

Moving averages (SMA/EMA/WMA), RSI, MACD, stochastic, stochastic RSI, ATR, DMI/ADX,
CCI, Williams %R, OBV, MFI, ROC, VWAP, anchored VWAP, Supertrend, Parabolic SAR,
Ichimoku, Bollinger Bands, Keltner Channels, Donchian Channels and volume.
Catalog presence is not verification of each formula's correctness or historical
data coverage. Nexus does not yet implement that entire catalog or separate
oscillator panes; this audit does not claim functional/numerical parity.

## Implemented in Nexus

Our existing Canvas2D engine now supports up to five independent EMA overlays.
The default period/color/enabled mapping follows the shared screener chart above.
Users can edit periods 1–500, color, width 1–4, solid/dashed/dotted style and opacity;
enable, add, remove or reset lines; then Apply. Inputs are validated before they
reach the renderer. Preferences are versioned in `nexus.chart.ema.v1`; invalid
saved preferences are ignored, and optional storage failure does not stop charting.
The compact chart legend uses each line's actual color and period.

EMA calculation remains Nexus's independently implemented close-price EMA,
SMA-seeded at the selected period. Replay recalculates from only the revealed
candle prefix. We have not verified identical seeding/adjustment semantics with
JournalToday. Their candlestick colors are not adopted: the user-selected deeper
green/muted red palette remains unchanged. No new charting dependency is installed.
