/** TradingView's plotshape shapes, drawn on a canvas around (x, y) at `size` pixels. */
export const MARKER_SHAPES = [
  ['arrowDown', 'Arrow Down'], ['arrowUp', 'Arrow Up'], ['circle', 'Circle'], ['cross', 'Cross'], ['diamond', 'Diamond'], ['flag', 'Flag'],
  ['labelDown', 'Label Down'], ['labelUp', 'Label Up'], ['square', 'Square'], ['triangleDown', 'Triangle Down'], ['triangleUp', 'Triangle Up'], ['xCross', 'X Cross'],
] as const;
export type MarkerShape = typeof MARKER_SHAPES[number][0];
export const isMarkerShape = (value: unknown): value is MarkerShape => MARKER_SHAPES.some(([id]) => id === value);

export interface MarkerStyle { visible?: boolean; color?: string; shape?: MarkerShape }
/** Fills missing fields from the default. */
export const markerStyle = (style: MarkerStyle | undefined, fallback: Required<MarkerStyle>): Required<MarkerStyle> => ({
  visible: style?.visible ?? fallback.visible,
  color: typeof style?.color === 'string' ? style.color : fallback.color,
  shape: isMarkerShape(style?.shape) ? style.shape : fallback.shape,
});

export function drawMarkerShape(context: CanvasRenderingContext2D, shape: MarkerShape, x: number, y: number, size: number, color: string) {
  const h = size / 2;
  context.save();
  context.fillStyle = context.strokeStyle = color;
  context.lineWidth = Math.max(1.25, size / 6);
  context.lineJoin = context.lineCap = 'round';
  context.beginPath();
  switch (shape) {
    case 'circle': context.arc(x, y, h, 0, Math.PI * 2); context.fill(); break;
    case 'square': context.fillRect(x - h, y - h, size, size); break;
    case 'diamond': context.moveTo(x, y - h); context.lineTo(x + h, y); context.lineTo(x, y + h); context.lineTo(x - h, y); context.closePath(); context.fill(); break;
    case 'triangleUp': context.moveTo(x, y - h); context.lineTo(x + h, y + h); context.lineTo(x - h, y + h); context.closePath(); context.fill(); break;
    case 'triangleDown': context.moveTo(x - h, y - h); context.lineTo(x + h, y - h); context.lineTo(x, y + h); context.closePath(); context.fill(); break;
    case 'cross': context.moveTo(x - h, y); context.lineTo(x + h, y); context.moveTo(x, y - h); context.lineTo(x, y + h); context.stroke(); break;
    case 'xCross': context.moveTo(x - h, y - h); context.lineTo(x + h, y + h); context.moveTo(x + h, y - h); context.lineTo(x - h, y + h); context.stroke(); break;
    case 'arrowUp': context.moveTo(x, y - h); context.lineTo(x + h, y); context.lineTo(x + h / 2.5, y); context.lineTo(x + h / 2.5, y + h); context.lineTo(x - h / 2.5, y + h); context.lineTo(x - h / 2.5, y); context.lineTo(x - h, y); context.closePath(); context.fill(); break;
    case 'arrowDown': context.moveTo(x, y + h); context.lineTo(x + h, y); context.lineTo(x + h / 2.5, y); context.lineTo(x + h / 2.5, y - h); context.lineTo(x - h / 2.5, y - h); context.lineTo(x - h / 2.5, y); context.lineTo(x - h, y); context.closePath(); context.fill(); break;
    case 'flag': context.moveTo(x - h, y + h); context.lineTo(x - h, y - h); context.lineTo(x + h, y - h / 2); context.lineTo(x - h, y); context.stroke(); context.beginPath(); context.moveTo(x - h, y - h); context.lineTo(x + h, y - h / 2); context.lineTo(x - h, y); context.closePath(); context.fill(); break;
    case 'labelUp': context.moveTo(x, y - h); context.lineTo(x + h, y - h / 3); context.lineTo(x + h, y + h); context.lineTo(x - h, y + h); context.lineTo(x - h, y - h / 3); context.closePath(); context.fill(); break;
    case 'labelDown': context.moveTo(x, y + h); context.lineTo(x + h, y + h / 3); context.lineTo(x + h, y - h); context.lineTo(x - h, y - h); context.lineTo(x - h, y + h / 3); context.closePath(); context.fill(); break;
  }
  context.restore();
}
