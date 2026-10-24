import { useRef } from 'react';
import type { Track } from '../../api/rotation';
import { useMountEffect } from '../../hooks/useMountEffect';
import { QUADRANTS, quadrantOf, type Quadrant, type RotationPoint } from '../../utils/rrg';

interface Props {
  tracks: Track[];
  /** Calendar index of the newest point shown. */
  cursor: number;
  /** First calendar index of the replay window; the focused item's full path starts here. */
  rangeStart: number;
  tail: number;
  /** Half-width of each axis around 100, fixed for a whole replay so motion stays comparable. */
  half: {x: number; y: number};
  /** Milliseconds a step takes to glide; 0 jumps (scrubbing). */
  glide: number;
  focusId: string | null;
  /** 0–1 per item: how strongly its trail is drawn, from how far it moved. Everything is plotted. */
  emphasis: ReadonlyMap<string, number>;
  /** Items that carry a name label (the biggest movers); the focused item is always labelled. */
  labelled: ReadonlySet<string>;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
  dateLabel: (index: number) => string;
}

const LABEL: Record<Quadrant, string> = {leading: 'Leading', weakening: 'Weakening', lagging: 'Lagging', improving: 'Improving'};
const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

/** Position at a fractional calendar index, gliding between the two periods either side. */
function at(track: Track, index: number): RotationPoint | null {
  const low = Math.floor(index), high = Math.ceil(index), t = index - low;
  const a = {x: track.ratio[low], y: track.momentum[low]}, b = {x: track.ratio[high], y: track.momentum[high]};
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return Number.isFinite(b.x) && Number.isFinite(b.y) && t > 0.999 ? b : null;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return t < 0.001 ? a : null;
  return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
}

function niceStep(half: number) {
  const raw = half / 3, power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map(step => step * power).find(step => step >= raw) ?? raw;
}

/**
 * The rotation chart, drawn on a canvas so thousands of trails can glide at full frame rate.
 * React re-renders once per step; the frames in between are interpolated here.
 */
export function RotationPlot(props: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  // Animation state lives outside React: where the window is now and where it is heading.
  const motion = useRef({from: props.cursor, to: props.cursor, started: 0, hover: null as string | null, dirty: true});
  if (motion.current.to !== props.cursor) {
    const now = performance.now();
    const shown = currentIndex(motion.current, now, props.glide);
    motion.current = {...motion.current, from: props.glide && Math.abs(props.cursor - shown) <= 1.001 ? shown : props.cursor,
      to: props.cursor, started: now, dirty: true};
  } else motion.current.dirty = true;

  function currentIndex(state: typeof motion.current, now: number, glide: number) {
    if (!glide || state.from === state.to) return state.to;
    const t = Math.min(1, (now - state.started) / glide);
    return state.from + (state.to - state.from) * ease(t);
  }

  useMountEffect(() => {
    const element = canvas.current!, container = wrap.current!;
    let frame = 0, size = {width: 0, height: 0};
    const heads = new Map<string, {x: number; y: number}>();
    const geometry = {left: 0, top: 0, side: 0};
    const resize = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      size = {width: rect.width, height: rect.height};
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(rect.width * ratio);
      element.height = Math.round(rect.height * ratio);
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      motion.current.dirty = true;
    });
    resize.observe(container);
    // Colours come from theme tokens, so a theme switch needs a redraw.
    const theme = new MutationObserver(() => { motion.current.dirty = true; });
    theme.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const props = latest.current, state = motion.current;
      const index = currentIndex(state, now, props.glide);
      const animating = index !== state.to;
      if (!animating && !state.dirty) return;
      state.dirty = false;
      const ctx = element.getContext('2d');
      if (!ctx || !size.width) return;
      const css = getComputedStyle(element);
      const color = (name: string) => css.getPropertyValue(name).trim() || '#888';
      const palette = Object.fromEntries(QUADRANTS.map(quadrant => [quadrant, color(`--rrg-${quadrant}`)])) as Record<Quadrant, string>;
      const ratio = window.devicePixelRatio || 1;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);

      // The plot is the whole stage; each axis scales on its own so nothing is wasted on a square.
      const left = 16, top = 16, width = Math.max(40, size.width - 32), height = Math.max(40, size.height - 40);
      Object.assign(geometry, {left, top, side: width});
      const {half} = props;
      const px = (x: number) => left + (x - (100 - half.x)) / (2 * half.x) * width;
      const py = (y: number) => top + (1 - (y - (100 - half.y)) / (2 * half.y)) * height;
      const mid = {x: px(100), y: py(100)};

      // Quadrant fields as faint washes, a hairline cross at 100, and ticks only along the cross.
      const fields: [Quadrant, number, number, number, number][] = [
        ['improving', left, top, mid.x - left, mid.y - top], ['leading', mid.x, top, left + width - mid.x, mid.y - top],
        ['lagging', left, mid.y, mid.x - left, top + height - mid.y], ['weakening', mid.x, mid.y, left + width - mid.x, top + height - mid.y]];
      for (const [quadrant, x, y, w, h] of fields) {
        ctx.fillStyle = palette[quadrant];
        ctx.globalAlpha = 0.04;
        ctx.fillRect(x, y, w, h);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color('--rrg-axis');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mid.x, top); ctx.lineTo(mid.x, top + height); ctx.moveTo(left, mid.y); ctx.lineTo(left + width, mid.y); ctx.stroke();
      ctx.font = '500 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = color('--rrg-muted');
      const ticks = (reach: number) => {
        const step = niceStep(reach), digits = step < 0.1 ? 2 : step < 1 ? 1 : 0, values: [number, string][] = [];
        for (let value = 100 - Math.floor(reach / step) * step; value <= 100 + reach + 1e-9; value += step) {
          if (Math.abs(value - 100) > 1e-9) values.push([value, value.toFixed(digits)]);
        }
        return values;
      };
      ctx.textAlign = 'center';
      for (const [value, text] of ticks(half.x)) {
        ctx.beginPath(); ctx.moveTo(px(value), mid.y - 3); ctx.lineTo(px(value), mid.y + 3); ctx.stroke();
        ctx.fillText(text, px(value), mid.y + 15);
      }
      ctx.textAlign = 'right';
      for (const [value, text] of ticks(half.y)) {
        ctx.beginPath(); ctx.moveTo(mid.x - 3, py(value)); ctx.lineTo(mid.x + 3, py(value)); ctx.stroke();
        ctx.fillText(text, mid.x - 7, py(value) + 3);
      }
      // Axis names sit at the ends of the cross, clear of the ticks.
      ctx.fillText('RS-Ratio →', left + width - 4, mid.y - 7);
      ctx.textAlign = 'left';
      ctx.fillText('↑ RS-Momentum', mid.x + 7, top + 10);

      const focus = props.focusId ?? state.hover;
      heads.clear();
      const visible: {track: Track; head: RotationPoint; quadrant: Quadrant; weight: number}[] = [];
      for (const track of props.tracks) {
        const head = at(track, index);
        if (!head) continue;
        const quadrant = quadrantOf(head);
        // Every item is plotted; the ones that moved most draw strongest, so the flow reads at a glance.
        const weight = focus ? (track.item.id === focus ? 1 : 0.06) : 0.12 + 0.88 * (props.emphasis.get(track.item.id) ?? 0);
        visible.push({track, head, quadrant, weight});
      }
      visible.sort((a, b) => a.weight - b.weight);
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
      const surface = color('--rrg-surface');
      const lit = visible;
      // The focused item also shows its whole path through the replay window.
      const focused = focus ? lit.find(entry => entry.track.item.id === focus) : undefined;
      if (focused) {
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = color('--rrg-text');
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        for (let i = props.rangeStart; i <= Math.floor(index); i++) {
          const point = at(focused.track, i);
          if (!point) { started = false; continue; }
          if (started) ctx.lineTo(px(point.x), py(point.y)); else { ctx.moveTo(px(point.x), py(point.y)); started = true; }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const {track, head, quadrant, weight} of lit) {
        // A smooth tapered trail: the oldest end fades out and thins.
        const points = [head];
        for (let k = 1; k <= props.tail; k++) {
          const point = at(track, index - k);
          if (!point) break;
          points.push(point);
        }
        ctx.strokeStyle = palette[quadrant];
        for (let k = 1; k < points.length; k++) {
          const share = 1 - (k - 1) / Math.max(1, points.length - 1);
          ctx.globalAlpha = weight * (0.15 + 0.75 * share);
          ctx.lineWidth = (0.6 + 2 * share) * (0.6 + 0.4 * weight);
          ctx.beginPath(); ctx.moveTo(px(points[k - 1].x), py(points[k - 1].y)); ctx.lineTo(px(points[k].x), py(points[k].y)); ctx.stroke();
        }
        for (let k = 1; k < points.length; k++) {
          ctx.globalAlpha = weight * (0.25 + 0.5 * (1 - k / points.length));
          ctx.fillStyle = palette[quadrant];
          ctx.beginPath(); ctx.arc(px(points[k].x), py(points[k].y), 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      for (const {track, head, quadrant, weight} of lit) {
        const x = px(head.x), y = py(head.y);
        heads.set(track.item.id, {x, y});
        ctx.globalAlpha = Math.max(0.35, weight);
        ctx.fillStyle = palette[quadrant];
        ctx.strokeStyle = surface;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, track.item.id === focus ? 6 : 2.5 + 2 * weight, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Labels only for spotlit items, as quiet pills, skipping any that would collide.
      const placed: {x: number; y: number; w: number; h: number}[] = [];
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const named = lit.filter(entry => focus ? entry.track.item.id === focus : props.labelled.has(entry.track.item.id));
      for (const {track, head} of named.sort((a, b) => b.weight - a.weight)) {
        const text = track.item.label.length > 22 ? `${track.item.label.slice(0, 21).trimEnd()}…` : track.item.label;
        const w = ctx.measureText(text).width + 12, h = 18;
        const x0 = px(head.x), y0 = py(head.y);
        const options = [{x: x0 + 9, y: y0 - h / 2}, {x: x0 - 9 - w, y: y0 - h / 2}, {x: x0 - w / 2, y: y0 - 12 - h}, {x: x0 - w / 2, y: y0 + 12}];
        const box = options.map(option => ({...option, w, h})).find(candidate => candidate.x >= left && candidate.x + w <= left + width
          && candidate.y >= top && candidate.y + h <= top + height
          && !placed.some(o => candidate.x < o.x + o.w && o.x < candidate.x + w && candidate.y < o.y + o.h && o.y < candidate.y + h));
        if (!box) continue;
        placed.push(box);
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = surface;
        ctx.beginPath(); ctx.roundRect(box.x, box.y, w, h, 9); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color('--rrg-text');
        ctx.textAlign = 'left';
        ctx.fillText(text, box.x + 6, box.y + 12.5);
      }
      ctx.restore();
      // Live quadrant watermark labels in each corner.
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const corner = (quadrant: Quadrant, x: number, y: number, align: CanvasTextAlign) => {
        ctx.textAlign = align;
        ctx.fillStyle = color('--rrg-muted');
        ctx.globalAlpha = 1;
        ctx.fillText(LABEL[quadrant].toUpperCase(), x, y);
      };
      corner('improving', left + 14, top + 20, 'left');
      corner('leading', left + width - 14, top + 20, 'right');
      corner('lagging', left + 14, top + height - 12, 'left');
      corner('weakening', left + width - 14, top + height - 12, 'right');
      ctx.globalAlpha = 1;
      if (state.hover) showTip(state.hover, index);
    };

    const showTip = (id: string, index: number) => {
      const box = tip.current!, head = heads.get(id), props = latest.current;
      const track = props.tracks.find(entry => entry.item.id === id);
      const point = track && at(track, Math.round(index));
      if (!head || !track || !point) { box.hidden = true; return; }
      box.hidden = false;
      box.style.transform = `translate(${Math.min(head.x + 12, size.width - 190)}px, ${Math.max(head.y - 64, 4)}px)`;
      box.innerHTML = '';
      const title = document.createElement('strong');
      title.textContent = track.item.label;
      const detail = document.createElement('span');
      detail.textContent = `${track.item.detail} · ${props.dateLabel(Math.round(index))}`;
      const values = document.createElement('dl');
      for (const [name, value] of [['RS-Ratio', point.x], ['RS-Momentum', point.y]] as const) {
        const term = document.createElement('dt'); term.textContent = name;
        const data = document.createElement('dd'); data.textContent = value.toFixed(2);
        values.append(term, data);
      }
      const quadrant = document.createElement('em');
      quadrant.dataset.quadrant = quadrantOf(point);
      quadrant.textContent = LABEL[quadrantOf(point)];
      box.append(title, detail, values, quadrant);
    };

    const nearest = (event: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      let best: string | null = null, distance = 10;
      for (const [id, head] of heads) {
        const d = Math.hypot(head.x - x, head.y - y);
        if (d < distance) { distance = d; best = id; }
      }
      return best;
    };
    const move = (event: MouseEvent) => {
      const id = nearest(event);
      if (id !== motion.current.hover) {
        motion.current.hover = id;
        motion.current.dirty = true;
        latest.current.onHover(id);
      }
      element.style.cursor = id ? 'pointer' : 'default';
      if (!id) tip.current!.hidden = true;
    };
    const leave = () => { motion.current.hover = null; motion.current.dirty = true; tip.current!.hidden = true; latest.current.onHover(null); };
    const click = (event: MouseEvent) => latest.current.onSelect(nearest(event));
    const open = (event: MouseEvent) => { const id = nearest(event); if (id) latest.current.onOpen(id); };
    element.addEventListener('mousemove', move);
    element.addEventListener('mouseleave', leave);
    element.addEventListener('click', click);
    element.addEventListener('dblclick', open);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      element.removeEventListener('mousemove', move);
      element.removeEventListener('mouseleave', leave);
      element.removeEventListener('click', click);
      element.removeEventListener('dblclick', open);
    };
  });

  return (
    <div ref={wrap} className="relative flex-1 min-h-[360px] w-full h-full">
      <canvas ref={canvas} role="img" aria-label="Relative rotation graph: RS-Ratio against RS-Momentum" className="absolute inset-0 block w-full h-full" />
      <div ref={tip} className="rot-tip" hidden />
    </div>
  );
}
