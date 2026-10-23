import type { ChartAppearance } from './ChartEngine';

/** Canvas and series colours that only make sense against one theme's background. */
export const THEME_COLOR_KEYS = [
  'upColor', 'downColor', 'borderUpColor', 'borderDownColor', 'wickUpColor', 'wickDownColor', 'lineColor',
  'backgroundColor', 'scaleTextColor', 'vertGridColor', 'horzGridColor', 'crosshairColor', 'watermarkColor',
] as const satisfies readonly (keyof ChartAppearance)[];
export type ThemeColorKey = typeof THEME_COLOR_KEYS[number];
export type ChartTheme = 'light' | 'dark';
export type ThemeColors = Partial<Pick<ChartAppearance, ThemeColorKey>>;

export const currentTheme = (): ChartTheme =>
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

const pick = (appearance: Partial<ChartAppearance>): ThemeColors =>
  Object.fromEntries(THEME_COLOR_KEYS.filter(key => appearance[key] !== undefined).map(key => [key, appearance[key]]));
const cleared = Object.fromEntries(THEME_COLOR_KEYS.map(key => [key, undefined])) as ThemeColors;

/** Saves before per-theme colours held one set, picked while the app was light. */
const saved = (appearance: ChartAppearance): NonNullable<ChartAppearance['themeColors']> =>
  appearance.themeColors ?? (Object.keys(pick(appearance)).length ? {light: pick(appearance)} : {});

/**
 * The appearance as `theme` shows it: colours picked in that theme, else the theme's defaults.
 * A white canvas chosen in light mode therefore never sits under dark-mode labels and panels.
 */
export function forTheme(appearance: ChartAppearance, theme: ChartTheme): ChartAppearance {
  return {...appearance, ...cleared, ...saved(appearance)[theme]};
}

/** Stores the colours of an edited appearance under `theme`, keeping the other theme's picks. */
export function withThemeColors(edited: ChartAppearance, previous: ChartAppearance, theme: ChartTheme): ChartAppearance {
  return {...edited, ...cleared, themeColors: {...saved(previous), [theme]: pick(edited)}};
}
