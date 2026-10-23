import { expect, it } from 'vitest';
import { forTheme, withThemeColors } from '../chart/themeColors';
import type { ChartAppearance } from '../chart/ChartEngine';

const base: ChartAppearance = {horizontalGrid: false, verticalGrid: false, crosshair: true, volume: true, scaleMode: 'normal'};

it('treats colours from older saves as light-theme picks', () => {
  const legacy = {...base, backgroundColor: '#ffffff', upColor: '#000000', volumePane: true};
  expect(forTheme(legacy, 'light')).toMatchObject({backgroundColor: '#ffffff', upColor: '#000000', volumePane: true});
  const dark = forTheme(legacy, 'dark');
  expect(dark.backgroundColor).toBeUndefined();
  expect(dark.upColor).toBeUndefined();
  expect(dark.volumePane).toBe(true); // only colours are per theme
});

it('saves edits under the current theme and keeps the other theme', () => {
  const legacy = {...base, backgroundColor: '#ffffff'};
  const edited = withThemeColors({...forTheme(legacy, 'dark'), upColor: '#26a69a'}, legacy, 'dark');
  expect(edited.backgroundColor).toBeUndefined();
  expect(edited.themeColors).toEqual({light: {backgroundColor: '#ffffff'}, dark: {upColor: '#26a69a'}});
  expect(forTheme(edited, 'light').backgroundColor).toBe('#ffffff');
  expect(forTheme(edited, 'dark')).toMatchObject({upColor: '#26a69a', backgroundColor: undefined});
  // Resetting colours in light mode leaves dark-mode picks alone.
  const reset = withThemeColors({...forTheme(edited, 'light'), backgroundColor: undefined}, edited, 'light');
  expect(reset.themeColors).toEqual({light: {}, dark: {upColor: '#26a69a'}});
});
