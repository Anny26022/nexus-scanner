import {
  QUADRANT_VAR,
  type RrgBounds,
  type RrgItem,
} from "./rrgShared";

interface RrgMicroMapProps {
  item: RrgItem;
  bounds: RrgBounds;
  size?: number;
}

/** Tiny schematic of where the theme sits inside the four rotation quadrants. */
export function RrgMicroMap({ item, bounds, size = 38 }: RrgMicroMapProps) {
  const pad = 3;
  const inner = size - pad * 2;
  const half = inner / 2;

  const cx = pad + half + (Math.max(-1, Math.min(1, item.x / bounds.x)) * half);
  const cy = pad + half - (Math.max(-1, Math.min(1, item.y / bounds.y)) * half);

  return (
    <svg
      className="rrg-micro"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect x={pad} y={pad} width={half} height={half} fill="var(--rrq-improving-soft)" />
      <rect x={pad + half} y={pad} width={half} height={half} fill="var(--rrq-leading-soft)" />
      <rect x={pad} y={pad + half} width={half} height={half} fill="var(--rrq-lagging-soft)" />
      <rect x={pad + half} y={pad + half} width={half} height={half} fill="var(--rrq-weakening-soft)" />
      <line x1={pad + half} y1={pad} x2={pad + half} y2={size - pad} className="rrg-micro__axis" />
      <line x1={pad} y1={pad + half} x2={size - pad} y2={pad + half} className="rrg-micro__axis" />
      <circle cx={cx} cy={cy} r={2.6} fill={QUADRANT_VAR[item.quadrant]} />
    </svg>
  );
}
