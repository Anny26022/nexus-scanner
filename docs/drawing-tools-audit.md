# Drawing tools: public-reference audit and implementation plan

Reviewed and implemented 16 October 2026. No restricted library bundle was
extracted and no Advanced Charts dependency was added. The reference is public
behavior and documented interfaces, not source code.

## Evidence and scope

- Compared the four supplied menu screenshots with Nexus source.
- Opened the official [Advanced Charts demo](https://charting-library.tradingview-widget.com/)
  in Chrome and exercised the drawing UI. The in-app browser initially exposed
  only empty chart/datafeed frames; Chrome rendered the demo successfully.
- Read the official [drawing overview](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/),
  [tool list](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/Drawings-List/)
  and [drawing API](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/drawings-api/).
- Representative interactions were tested, not every tool or mathematical output.
  This is not a numerical-parity certification. The live demo version was not pinned.

Directly observed in the demo:

1. Trend-tool disclosure groups lines, channels and pitchforks. Entries have
   favorite controls; the group button remembers the chosen tool.
2. Created a parallel channel. The undo control identified that operation;
   the object tree listed it. Double-clicking its object-tree entry opened settings.
3. Channel settings expose Style, Text, Coordinates and Visibility. Coordinates
   contain two price/bar endpoints plus a price offset. Style includes optional
   internal levels, extension and background controls. Three placement inputs
   therefore need not mean three independently stored endpoint coordinates.
4. Created a long-position object and opened its settings from the object tree.
   Inputs include account size, lot size, risk/unit, entry, profit and stop levels,
   leverage and quantity precision. It is substantially more than a colored box.
5. Toolbar controls expose drawing magnet snapping to OHLC, keep drawing,
   lock, hide, removal and object management. Existence was observed; every
   combination and persistence behavior was not tested.

Our proposed search/menu organization follows the supplied screenshots. Their
individual labels and grouping are not proof that every entry is included in
every Advanced Charts build. In particular, Pin, Table and Anchored Volume Profile
must not be advertised as verified public-library capabilities solely from these
screenshots. The official tool list is a separate inventory.

## Implementation status

Nexus now exposes the complete 87 named drawing tools ported 1-to-1 from OpenAlgo Charts
in a grouped, searchable picker with favourites. All older in-house-only drawing tools
have been removed in favor of the canonical OpenAlgo 87-tool catalogue. The drawing document
is versioned (`v2`) and stores arbitrary anchor arrays, a shared style, visibility and locking state.
Legacy `v1` two-point drawings are migrated on load. Placement, hit-testing,
dragging, coordinate editing, undo/redo, per-symbol persistence, keyboard
cancellation, keep-drawing and OHLC magnet snapping are common to the tool
registry, rather than separate code paths per menu entry.

The geometric tools render through shared lines, polygons, curves, labels,
grids, Fibonacci levels and series-derived paths. Regression and anchored VWAP
use the published bars. Position tools intentionally state that they are
price-only annotations; they do not invent broker quantities. Gann tools label
their current screen-scale convention rather than implying a price-per-bar or
log-scale equivalent.

The two volume-profile entries remain visible but disabled with an explicit
"Needs intraday data" explanation: they cannot be truthful implementations
from only daily OHLCV. This is a data prerequisite, not a hidden fallback.

This is broad functional coverage, not a numerical- or UI-parity claim for
every specialist Advanced Charts drawing. In particular, specialist settings,
scale policies, forecast models and editable volume profiles need their own
acceptance fixtures before claiming parity.

## Earlier Nexus baseline: seven drawing kinds

`frontend/src/chart/drawings.ts` defines trendline, horizontal line, vertical line,
ray, rectangle, Fibonacci retracement and text. Cursor/select is an action, not an
eighth drawing kind. They support selection, endpoint/body edits, deletion,
undo/redo, limited colors/widths and per-symbol local persistence.

The renderer already uses Lightweight Charts primitives, native horizontal price
lines, coordinate conversion, hit testing and selected price/time labels.
These are reusable integration points, not a missing chart-rendering engine.

Baseline gaps identified before this implementation:

- Every object has only `a` and `b`; gesture state and handle editing hard-code
  these two names. There is no multi-point or freehand document model.
- `singleAnchor()` and several renderer branches enumerate tool names directly.
  Adding many tools this way would spread conditional logic across five layers.
- Time projection clamps out-of-history positions to the first/last candle.
  Right-gutter forecasting and tools extending into the future need an explicit
  coordinate policy, not fabricated candles or guessed calendar sessions.
- Translating a body uses timestamp deltas. Across weekends and irregular trading
  gaps, this is not necessarily movement by a consistent number of bars.
- Crosshair magnet mode does not snap drawing anchors: drawing placement currently
  converts raw pointer prices. These are separate features.
- Fibonacci has seven fixed levels. There are no configurable levels, extensions,
  fill/opacity, line styles, font controls, tool defaults or reusable style templates.
- No drawing favorites/search, lock/hide/stay-in-mode controls, multi-selection,
  grouping, ordering controls or indicator-pane ownership.
- Selection state is shared with the symbol-owned document. Independent tiles
  need per-editor selection/tool/gesture state while sharing committed geometry.
- Current validation/storage and undo copying assume the existing two-point shape;
  changing the schema without migration would discard or miscopy old drawings.

## Reference inventory from the supplied screenshots

The table below records the observed public menu and intended semantics. The
implementation-status section above supersedes the older “need” wording in the
last column; it remains as a design and audit trail, not shipping status.

84 unique named drawing entries in 15 groups, excluding Cursor, color/width,
magnet and delete controls. Seven basic equivalents exist; 77 entries are not
implemented. Existing tools are not claimed to have full reference settings parity.

| Family | Named entries in supplied screenshots | Nexus / implementation need |
| --- | --- | --- |
| Trend lines (9) | Trend line; Ray; Info line; Extended line; Trend angle; Horizontal line; Horizontal ray; Vertical line; Cross line | Four exist. Extend line geometry, measurement labels, one-point cross/horizontal ray; define angle and scale behavior. |
| Channels (4) | Parallel channel; Regression trend; Flat top/bottom; Disjoint channel | Offset or independent rails, fills, middle/level lines; regression additionally reads the selected candle window. |
| Pitchforks (4) | Pitchfork; Schiff pitchfork; Modified Schiff pitchfork; Inside pitchfork | Multi-point placement plus independently specified median-line transforms and extensions. |
| Fibonacci (11) | Fib retracement; Trend-based fib extension; Fib channel; Fib time zone; Fib speed resistance fan; Trend-based fib time; Fib circles; Fib spiral; Fib speed resistance arcs; Fib wedge; Pitchfan | Retracement exists with fixed levels only. Other variants need configurable ratios, multi-point geometry, arc/curve renderers and time/bar conventions. |
| Gann (4) | Gann box; Gann square fixed; Gann square; Gann fan | Define price-per-bar units, scale locking and log behavior before implementing; a visually similar grid is not sufficient. |
| Patterns (6) | XABCD pattern; Cypher pattern; Head and shoulders; ABCD pattern; Triangle pattern; Three drives pattern | Arbitrary anchor arrays, labels, ratios and optional fills. These are manual annotations, not automatic pattern detection. |
| Elliott waves (5) | Elliott impulse (1–2–3–4–5); Elliott correction (A–B–C); Elliott triangle (A–B–C–D–E); Elliott double combo (W–X–Y); Elliott triple combo (W–X–Y–X–Z) | Shared multi-point path plus label sequences and configurable degree/style; not a wave-recognition engine. |
| Cycles (3) | Cyclic lines; Time cycles; Sine line | Repeated bar/logical-time geometry; period, phase, bounds and scale semantics. |
| Forecasting (6) | Long position; Short position; Position forecast; Bars pattern; Ghost feed; Sector | Risk/reward inputs and derived labels; candle-range capture for bars pattern; authored synthetic paths for ghost feed; angular shape for sector. No broker orders. |
| Volume tools (3) | Anchored VWAP; Fixed range volume profile; Anchored volume profile | VWAP can use existing daily bars with explicit resolution semantics. Reference volume-profile reproduction requires richer lower-timeframe data. |
| Measurers (3) | Price range; Date range; Date and price range | Shared two-point range overlay, absolute/percent changes, actual-bar counts and elapsed time. |
| Brushes (2) | Brush; Highlighter | Pointer sample arrays, stroke simplification, alpha, stroke hit testing, capped point counts. |
| Arrows (4) | Arrow; Arrow marker; Arrow mark up; Arrow mark down | Line plus arrowhead, or one-point symbol; shared marker hit boxes and sizing. |
| Shapes (10) | Rectangle; Rotated rectangle; Ellipse; Circle; Triangle; Polyline; Path; Curve; Double curve; Arc | Rectangle exists. General points, curve controls, fills; choose screen-space versus data-space circle semantics. |
| Text and notes (10) | Text; Note; Price note; Pin; Callout; Comment; Price label; Signpost; Flag mark; Table | Text exists. Richer label/box/callout variants share text layout, wrapping, alignment and edit behavior; tables need their own bounded data editor. No implied multi-user commenting backend. |

## Architecture: grow shared primitives, not 77 special implementations

Recommended foundation, before expanding menus:

1. Add a versioned drawing document with `points[]`, tool-specific validated
   parameters and shared style/visibility/lock properties. Migrate v1 `a/b` objects
   explicitly; retain existing IDs and symbol ownership. Reject malformed input.
2. Use a typed tool registry: category, icon, gesture mode, required/minimum point
   count, parameter schema, default style and renderer/hit-test references. Fixed
   point tools, finish-on-double-click paths and freehand strokes differ.
3. Separate document state from each chart editor's selection, active tool,
   draft and pointer capture. Keep completed edits transactional for undo/persistence;
   never serialize every pointer move or redraw all 16 charts on each draft update.
4. Share segments/rays, closed polygons, ellipses/arcs, Bezier curves, labels,
   fills and series-derived paths. Use native price lines for eligible horizontal
   levels and native series for calculated paths when that simplifies lifecycle.
   Continue using primitives for custom drawing rendering; do not add another chart.
5. Add a session-aware time/logical-coordinate adapter. Preserve actual date anchors
   on resolution changes; handle the right gutter explicitly without inventing
   market data. Decide how future offsets behave when real candles arrive.
6. Add the shared UI once: grouped searchable chooser, favorites, tool defaults,
   selected-object style/coordinates/visibility editor, lock/hide, stay-in-mode,
   OHLC anchor magnet and object list. Include keyboard and touch cancellation.

Do not expose inert menu items as implemented tools. A shared renderer family can
support several tools, but formulas, constraints and settings still need testing.

## Data and semantic boundaries

Most geometric tools need no new network requests. Regression needs selected bar
values; bars-pattern copies must reference only available/revealed bars.

Anchored VWAP: for an explicit daily-bar HLC3 source, calculate cumulative
`sum(((high + low + close) / 3) * volume) / sum(volume)` from the chosen session.
Specify missing-volume, zero-volume and source options. Prefer calculations from
base daily bars before weekly/monthly display aggregation if retaining the same
daily-resolution definition. Do not call this intraday/tick VWAP parity. Our
existing monthly-reset VWAP study is not this user-anchored drawing.
See [TradingView's anchored VWAP explanation](https://www.tradingview.com/support/solutions/43000669764-anchored-vwap-drawing-tool/).

Volume profiles: daily OHLCV does not identify volume traded at each price.
TradingView describes lower-timeframe inputs for its profiles. A histogram formed
by allocating an entire daily bar's volume to close, or uniformly across its range,
would be an assumption, not equivalent data. Defer reference-equivalent profiles
until suitable lower-timeframe coverage exists; any optional approximation must
be clearly named and opt-in, not a silent fallback.
See [official volume-profile calculation notes](https://www.tradingview.com/support/solutions/43000502040-volume-profile-indicators-basic-concepts/).

Position tools need instrument tick size, quantity/lot units and optional currency
conventions for reliable sizing. Without those, support price/% risk-reward first
and do not invent precise executable order quantities. They remain annotations.
Gann and angle tools require a documented scale policy; pixels and price units
cannot be treated as interchangeable, especially in logarithmic mode.

## API distinction

Advanced Charts documents `createShape`, `createMultipointShape`,
`createAnchoredShape`, entity IDs, property/point management, drawing events and
group controllers. These define useful interaction contracts, but they are
**not Lightweight Charts APIs** and cannot be enabled in our installed package.
Integrating them directly requires the authorized Advanced Charts distribution.
For our independent renderer, implement equivalent application contracts using
Lightweight Charts primitives and the existing data adapter.

## Further parity hardening sequence

1. Foundation and compatibility: registry, document migration, multi-point gestures,
   projection semantics, editor/document separation, shared style and object actions.
2. High-use tools: remaining lines, arrows, range measurers, parallel channel,
   ellipse/circle/triangle, polyline, brush/highlighter, richer notes.
3. Analytical tools: risk/reward, regression, editable Fibonacci levels/extensions,
   anchored daily-bar VWAP. Pin formulas and data conventions with fixtures.
4. Specialist geometry: pitchforks, remaining Fibonacci/Gann tools, manual patterns,
   Elliott labels, cycles, curves, bars pattern/ghost feed and table editing.
5. Volume profiles only after resolving the data prerequisite; never hide that
   prerequisite behind a superficially working control.

This sequence is a recommendation, not work already implemented. Exact reference
behavior for each specialist tool still requires focused observation and tests.

Acceptance tests for implementation: v1 migration and v2 round-trip; every tool's
anchor/parameter validation and undo transaction; hit regions and overlapping
objects; pointer cancel/Escape/double-click completion; log/linear and D/W/M;
weekends, sparse/new listings and future gutter; deterministic formulas; no
unrevealed replay inputs; lock/hide semantics; local-save failures; light/dark,
320px touch layout and keyboard operation; 16-chart profiling on representative
hardware. Do not claim broad TradingView parity from one visual screenshot.
