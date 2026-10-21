import { ArrowUpRight, ChevronRight, Compass, Info, X } from "lucide-react";
import {
  QUADRANT_BLURB,
  QUADRANT_ORDER,
  QUADRANT_VAR,
  fmtCompact,
  fmtNum,
  fmtSigned,
  isBlockItem,
  isIpoItem,
  isThematicIndexItem,
  itemKey,
  itemSubtitle,
  toneClass,
  trailFor,
  type RrgBounds,
  type RrgItem,
} from "./rrgShared";
import { RrgMicroMap } from "./RrgMicroMap";

interface RrgInspectorProps {
  item: RrgItem | null;
  scope: RrgItem[];
  weeks: number;
  onClose: () => void;
  onDrillIntoBlock: (block: string) => void;
  onOpenConstituents: () => void;
  bounds: RrgBounds;
}

function TrailSparkline({ item, weeks }: { item: RrgItem; weeks: number }) {
  const points = trailFor(item, weeks, isIpoItem(item));
  if (points.length < 2) return null;

  const width = 268;
  const height = 66;
  const pad = 6;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const toX = (x: number) => pad + ((x - minX) / spanX) * (width - pad * 2);
  const toY = (y: number) => height - pad - ((y - minY) / spanY) * (height - pad * 2);

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.x).toFixed(1)} ${toY(p.y).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const color = QUADRANT_VAR[item.quadrant];

  return (
    <div className="rrg-spark">
      <div className="rrg-spark__label">
        <span>{points.length - 1}-week rotation path</span>
        <span className="rrg-spark__hint">oldest → latest</span>
      </div>
      <svg className="rrg-spark__svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={toX(p.x)} cy={toY(p.y)} r={i === points.length - 1 ? 3 : 1.8} fill={color} opacity={i === points.length - 1 ? 1 : 0.45} />
        ))}
        <circle cx={toX(last.x)} cy={toY(last.y)} r={6} fill={color} opacity={0.18} />
      </svg>
    </div>
  );
}

export function RrgInspector({
  item,
  scope,
  weeks,
  onClose,
  onDrillIntoBlock,
  onOpenConstituents,
  bounds,
}: RrgInspectorProps) {
  const counts = QUADRANT_ORDER.map((quadrant) => {
    const bucket = scope.filter((entry) => entry.quadrant === quadrant);
    const avgX = bucket.length
      ? bucket.reduce((sum, entry) => sum + entry.x, 0) / bucket.length
      : 0;
    return { quadrant, count: bucket.length, avgX };
  });
  const total = scope.length || 1;
  const leading = counts.find((entry) => entry.quadrant === "Leading")?.count ?? 0;
  const improving = counts.find((entry) => entry.quadrant === "Improving")?.count ?? 0;

  return (
    <aside className="rrg-inspector">
      <div className="rrg-inspector__head">
        <div className="rrg-inspector__eyebrow">
          <Compass size={12} />
          <span>
            {item
              ? isIpoItem(item)
                ? "IPO SPOTLIGHT"
                : "THEME SPOTLIGHT"
              : "ROTATION SUMMARY"}
          </span>
        </div>
        {item && (
          <button className="rrg-icon-btn" onClick={onClose} title="Close inspector" aria-label="Close inspector">
            <X size={13} />
          </button>
        )}
      </div>

      <div className="rrg-inspector__body">
        {!item && (
          <>
            <div className="rrg-summary__brief">
              <span className="rrg-summary__kicker">At a glance</span>
              <p className="rrg-summary__headline">
                <b>{leading}</b> leading · <b>{improving}</b> gaining momentum
              </p>
              <p className="rrg-summary__axes">
                Right is outperforming NIFTY 500. Up is strengthening relative momentum.
              </p>
            </div>

            <div className="rrg-dist" role="img" aria-label="Quadrant distribution">
              {counts.map((entry) => (
                <span
                  key={entry.quadrant}
                  className="rrg-dist__seg"
                  style={{
                    width: `${(entry.count / total) * 100}%`,
                    background: QUADRANT_VAR[entry.quadrant],
                  }}
                  title={`${entry.quadrant}: ${entry.count}`}
                />
              ))}
            </div>

            <div className="rrg-summary__grid" aria-label="Quadrant summary">
              {counts.map((entry) => (
                <div key={entry.quadrant} className="rrg-summary__cell">
                  <div className="rrg-summary__cell-top">
                    <span className="rrg-summary__dot" style={{ background: QUADRANT_VAR[entry.quadrant] }} />
                    <span className="rrg-summary__name">{entry.quadrant}</span>
                    <strong className="rrg-summary__count">{entry.count}</strong>
                  </div>
                  <div className={`rrg-summary__avg ${toneClass(entry.avgX)}`}>avg {fmtSigned(entry.avgX)}</div>
                </div>
              ))}
            </div>

            <ul className="rrg-summary__legend">
              {QUADRANT_ORDER.map((quadrant) => (
                <li key={quadrant}>
                  <span className="rrg-summary__legend-dot" style={{ background: QUADRANT_VAR[quadrant] }} />
                  <b>{quadrant}</b>
                  <span>{QUADRANT_BLURB[quadrant]}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {item && (
          <>
            <div className="rrg-spot">
              <div className="rrg-spot__top">
                <div>
                  <div className="rrg-spot__name">{itemKey(item)}</div>
                  <div className="rrg-spot__sub">{itemSubtitle(item)}</div>
                </div>
                <RrgMicroMap item={item} bounds={bounds} size={46} />
              </div>
              <div className="rrg-spot__quad" style={{ color: QUADRANT_VAR[item.quadrant] }}>
                <span className="rrg-spot__quad-dot" style={{ background: QUADRANT_VAR[item.quadrant] }} />
                {item.quadrant}
              </div>
            </div>

            <div className="rrg-tiles">
              <div className="rrg-tile">
                <span className="rrg-tile__label">
                  {isIpoItem(item) ? "10D / LTD excess" : "3M excess return"}
                </span>
                <span className={`rrg-tile__value ${toneClass(item.x)}`}>{fmtSigned(item.x)}</span>
              </div>
              <div className="rrg-tile">
                <span className="rrg-tile__label">
                  {isIpoItem(item) ? "Turnover intensity" : "21D RS momentum"}
                </span>
                <span className={`rrg-tile__value ${toneClass(item.y)}`}>
                  {fmtSigned(item.y, isIpoItem(item) ? "%" : " pts")}
                </span>
              </div>
            </div>

            <TrailSparkline item={item} weeks={weeks} />

            {isIpoItem(item) ? (
              <dl className="rrg-specs">
                <div><dt>Price</dt><dd>₹{fmtNum(item.close)}</dd></div>
                <div><dt>1-day change</dt><dd className={toneClass(item.changePct)}>{fmtSigned(item.changePct)}</dd></div>
                <div><dt>Gain since listing</dt><dd className={toneClass(item.gainSinceListingPct)}>{fmtSigned(item.gainSinceListingPct)}</dd></div>
                <div><dt>Listed</dt><dd>{item.listingDate}</dd></div>
                <div><dt>Sessions</dt><dd>{item.sessions}</dd></div>
                <div><dt>Daily turnover</dt><dd>₹{fmtNum(item.turnoverCr)} Cr</dd></div>
                <div><dt>Market cap</dt><dd>₹{fmtCompact(item.marketCapCr)}</dd></div>
                <div><dt>Block</dt><dd>{item.block ?? "—"}</dd></div>
              </dl>
            ) : isThematicIndexItem(item) ? (
              <dl className="rrg-specs">
                <div><dt>Index symbol</dt><dd>{item.indexSymbol}</dd></div>
                <div><dt>Index RS rating</dt><dd>{fmtNum(item.metrics.medianRs, 0)}</dd></div>
                <div><dt>1M / 3M excess</dt><dd>{fmtSigned(item.metrics.excessReturn1m)} / {fmtSigned(item.metrics.excessReturn3m)}</dd></div>
                <div><dt>6M excess</dt><dd>{fmtSigned(item.metrics.excessReturn6m)}</dd></div>
                <div><dt>Source</dt><dd>Official NSE index OHLCV</dd></div>
              </dl>
            ) : (
              <>
                <div className="rrg-breadth">
                  <div className="rrg-breadth__head">
                    <span>Breadth vs benchmark</span>
                    <b>{fmtNum(item.metrics.beatingBenchmarkPct)}%</b>
                  </div>
                  <div className="rrg-breadth__track">
                    <div
                      className="rrg-breadth__fill"
                      style={{ width: `${Math.min(100, Math.max(0, item.metrics.beatingBenchmarkPct))}%` }}
                    />
                  </div>
                </div>

                <dl className="rrg-specs">
                  <div><dt>Median RS rating</dt><dd>{fmtNum(item.metrics.medianRs, 0)}</dd></div>
                  <div><dt>Improving RS</dt><dd>{fmtNum(item.metrics.improvingRsPct)}%</dd></div>
                  <div><dt>Setup coverage</dt><dd>{fmtNum(item.metrics.setupCoveragePct)}%</dd></div>
                  <div><dt>1M / 6M excess</dt><dd>{fmtSigned(item.metrics.excessReturn1m)} / {fmtSigned(item.metrics.excessReturn6m)}</dd></div>
                  <div><dt>20D turnover</dt><dd>₹{fmtCompact(item.metrics.totalTurnover20Cr)}</dd></div>
                  <div><dt>Top-3 concentration</dt><dd>{fmtNum(item.metrics.concentrationTop3Pct)}%</dd></div>
                  <div><dt>Constituents</dt><dd>{item.metrics.constituentCount}</dd></div>
                </dl>

                {item.metrics.topContributors.length > 0 && (
                  <div className="rrg-contributors">
                    <span className="rrg-contributors__label">Top contributors</span>
                    <div className="rrg-chips">
                      {item.metrics.topContributors.map((contributor) => (
                        <span key={contributor} className="rrg-chip">{contributor}</span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="rrg-inspector__actions">
              {!isIpoItem(item) && !isThematicIndexItem(item) && (
                <button className="rrg-btn rrg-btn--primary" onClick={onOpenConstituents}>
                  <span>Explore {item.metrics.constituentCount} Stocks</span>
                  <ArrowUpRight size={14} />
                </button>
              )}
              {isBlockItem(item) && (
                <button className="rrg-btn rrg-btn--ghost" onClick={() => onDrillIntoBlock(item.name)}>
                  <span>View {item.nicheCount} Niches in Block</span>
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          </>
        )}

        {!item && (
          <p className="rrg-inspector__hint">
            <Info size={13} />
            Click a node on the chart or a row in the rankings table to inspect rotation metrics, breadth and constituents.
          </p>
        )}
      </div>
    </aside>
  );
}
