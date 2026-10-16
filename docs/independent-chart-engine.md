# Chart workspace

The Charts tab uses TradingView Lightweight Charts 5.2.1. `ChartEngine.ts`
connects its documented public APIs to the existing Nexus controls. The former
custom candle renderer and manual axis/viewport calculations have been removed.
The native attribution logo is disabled; the required library notice and link
are available in Chart Settings instead of being repeated in each chart footer.

The workspace uses one compact toolbar. Chart styles share a selector; the drawing
rail opens from the pencil button. Company snapshot metrics use a plain compact
readout, which scrolls horizontally on narrow screens. Phone widths
use an interval selector and icon controls in the same header. These controls use
the same engine and drawing book; opening a dialog or rail does not reset either.

## Reference appearance

The reference screener uses green `#089981` and red `#EF5350`. Native candle
bodies, borders and wicks use matching colors. HLC bars use `thinBars: false`
and `openVisible: false`. Volume uses the same hues at 50% opacity. These colors
are chart local; the rest of the application keeps its existing theme.

## Connected native APIs

| UI / behavior | Lightweight Charts API |
| --- | --- |
| Responsive renderer and theme | createChart, autoSize, applyOptions, remove |
| Candles, HLC bars, line, Area and Baseline | addSeries, removeSeries, setData, setSeriesOrder; only the active price series is retained |
| Volume overlay or resizable pane, missing volume | HistogramSeries, moveToPane, setStretchFactor, whitespace data |
| EMA styling | LineSeries, lineWidth, lineStyle, alpha color |
| Closed-bar replay updates / rewind | series.update for appends, pop for prefix shortening, setData for other resets |
| Replay bar picking | subscribeClick and subscribeCrosshairMove logical indices; keyboard picking remains available |
| Hovered OHLC/readout | subscribeCrosshairMove, unsubscribeCrosshairMove |
| Zoom, keyboard pan and reset | getVisibleLogicalRange, setVisibleLogicalRange |
| Calendar-month ranges / all history | setVisibleRange, fitContent |
| Regular, logarithmic, percentage, indexed scales | priceScale.applyOptions, PriceScaleMode |
| Auto and native axis drag / wheel / pinch | setAutoScale and built-in navigation |
| Existing drawings and replay guide | attachPrimitive, detachPrimitive, paneViews, coordinate conversion |
| Horizontal drawings / selected-anchor labels | createPriceLine, removePriceLine, priceAxisViews, timeAxisViews, hitTest |
| Resize / append viewport behavior | lockVisibleTimeRangeOnResize, shiftVisibleRangeOnNewBar |
| Latest / go to date | scrollToPosition, timeToIndex |
| Free, close and OHLC snapping | CrosshairMode.Normal, Magnet, MagnetOHLC |
| RSI 14 / MACD 12,26,9 | Native line and histogram series in resizable panes; Nexus calculations |
| Comparison overlay or synchronized pane | Additional LineSeries sharing the native time scale and crosshair |
| Earnings, corporate actions, news | createSeriesMarkers; optional grouped dots, click to inspect |
| Optional dense-history rendering | enableConflation; disabled by default, no speedup claim |
| Save chart image | takeScreenshot |

The native chart instance is available to the adapter as a typed IChartApi. APIs
are called for real UI behavior; there is no wrapper method for every unused SDK
function. The installed library's TypeScript declarations remain the complete
API contract.

Nexus still owns the release-pinned CDN data adapter, daily/weekly/monthly
aggregation, EMA calculation, DrawingBook/undo/redo, seven drawing tools, and
ReplayClock. There is no extra TradingView market-data request. Replay only passes
revealed candles into the renderer and EMA calculations. Snapshot metadata is
hidden during replay. Events use filing dates, ex-dates and published news dates,
never fiscal quarter-end dates. Same-day filing rows are deduplicated. Markers
are disabled by default to avoid clutter, grouped to one dot per candle when
enabled, and expose their published details on click or through Settings.
Only events through the revealed closed daily/weekly/monthly bar are shown.
Trading-window notices present in the published earnings ledger are shown as
news, not mislabeled as earnings results. The source ledger's historical filing
associations remain an upstream data-quality limitation, not something the
chart renderer verifies or repairs.
Existing immutable data releases are untouched.

Comparison history uses the same pinned release, existing adapter and React Query
cache. Only exact dates present in the primary chart are rendered, including
during replay. Overlay mode uses a shared percentage scale for meaningful return
comparison; removing it or moving it to a separate pane restores the chosen
primary scale. Separate panes share navigation and crosshair natively, without a
second chart instance or manual synchronization listeners. No comparison candle
is fabricated for missing sessions. RSI uses Wilder smoothing after 14 changes;
MACD uses SMA-seeded EMA12 minus EMA26 and an EMA9 signal, with whitespace warmup.
Indicator formulas are not claimed to be bit-for-bit TradingView equivalents.
Appends update the indicator series; rewinds pop the same number of points.

Drawings use time/price anchors projected through native logical and price
coordinates; the drawing primitive moves to the active series when the chart
style changes. It stays aligned during native zoom, pan, price-scale changes and
resize. Completed drawings are stored per symbol in versioned browser localStorage,
shared between tiles showing that symbol and restored across reloads. Selection,
drafts and replay drawings are not persisted. Undo/redo remains session-local.
Stored anchors, colors, document shape and unique IDs are validated before load.
The drawing limit is 500 per symbol; creation controls disable at the limit.

## Independent charts and saved layouts

The compact workspace strip opens an icon-only matrix with 56 arrangements for one
through ten, twelve, fourteen or sixteen independent native chart instances. These include horizontal
and vertical splits, regular grids and large-primary-chart layouts. Each tile has
its own symbol, interval, style, studies, comparison,
scale and replay controls. On phones, multi-chart layouts stack vertically rather
than squeezing charts into unusably narrow columns. Existing release-pinned
queries and cached immutable objects are reused; there is no new data endpoint.

Separate switches link subsequent symbol changes, interval changes, visible dates
and crosshairs. There is no cluster switch because the workspace has no cluster
groups. Date linking forwards native visible **calendar date** ranges, never logical
indices from unrelated listing histories. Crosshairs use the target's own close
on an exact matching candle date and clear when no matching date exists. The
active pointer/focus source and a reentrancy guard prevent feedback loops. Replay
instances do not participate in synchronization, so another tile cannot expose
future bars inside replay. All subscriptions are removed before chart disposal.

The current grid and tile settings autosave on this browser. View changes are
debounced by 200ms; pane weights and views are also saved on pointer-up, pagehide
and normal teardown. Replay views never overwrite normal saved views. Up to ten
named layouts remember all sixteen tile configurations and can be loaded or deleted
from Layouts. Loading a layout invalidates outgoing autosaves before restoring
its settings. Drawings remain symbol-owned, not separate copies inside layouts.
Storage failures show a visible warning without preventing chart use. There is
no account/cloud sync or cross-browser persistence; clearing site storage removes
these local saves. Legacy four- and eight-tile saves and their combined date/crosshair link
setting are migrated on load. Desktop grids preserve a usable minimum tile size
and scroll when necessary; phone layouts stack vertically.
Only selected tiles mount chart engines and request history. Shrinking a grid
disposes hidden engines while retaining their saved settings; larger grids still
cost proportionally more rendering work, especially with multiple indicator panes.

## Additional studies

Alongside configurable EMA lines, RSI14 and MACD12/26/9, the indicator dialog adds:

- SMA50: arithmetic mean of 50 closes.
- Bollinger Bands20: SMA20 ± two population standard deviations.
- ATR14: true range with a 14-bar arithmetic seed followed by Wilder smoothing.
- Fast Stochastic: raw 14-bar %K with a three-bar SMA %D; flat ranges return 50.
- Monthly anchored VWAP: cumulative HLC3 × volume divided by volume, resetting
  each calendar month. This is a **daily-bar approximation**, not true intraday
  session VWAP. It is unavailable on weekly/monthly aggregation; missing volume
  makes the remainder of that month's values unavailable rather than zero.

All study warmups remain whitespace. Calculations consume only revealed replay
candles; native series render and resize the outputs. Periods for these added
studies are fixed and labeled; configurable study parameters remain future work.

## Scope and attribution

Lightweight Charts is TradingView's open-source rendering library, not the full
TradingView platform or licensed Advanced Charts. It does not automatically
provide Pine Script, a drawing toolbar, a complete indicator catalog, alerts,
orders, a strategy tester or Bar Replay. Existing Nexus tools and replay remain
application features. Remaining work: live/intraday data; more indicator families
and editable study periods; separate-window linking; cloud/account saves; and
alert/trading backends. Those are not provided automatically by Lightweight
Charts. Independent grids are distinct from the optional comparison panes within
one chart. Conflation is an opt-in library setting,
not a measured performance improvement; representative-device benchmarking is
still needed before considering it as a default.

The chart includes the native attribution logo and a public TradingView link:
TradingView Lightweight Charts™. Copyright (с) 2025 TradingView, Inc.
https://www.tradingview.com/

Official references:
- https://tradingview.github.io/lightweight-charts/docs
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IChartApi
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ITimeScaleApi
- https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IPriceScaleApi
- https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives
