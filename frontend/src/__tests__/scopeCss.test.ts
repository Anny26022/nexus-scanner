import {expect, it} from 'vitest';
import {scopeCss, scopeSelector} from '../../lib/scopeCss';

it('turns document-level selectors into the scanner root', () => {
  expect(scopeSelector(':root')).toBe('.nexus-scanner-root');
  expect(scopeSelector(':root[data-theme="dark"] .primary-nav')).toBe('.nexus-scanner-root[data-theme="dark"] .primary-nav');
  expect(scopeSelector('html')).toBe('.nexus-scanner-root');
  expect(scopeSelector('body')).toBe('.nexus-scanner-root');
  expect(scopeSelector(':host')).toBe('.nexus-scanner-root');
  expect(scopeSelector('.is-resizing-dock .nexus-chart-canvas')).toBe('.nexus-scanner-root.is-resizing-dock .nexus-chart-canvas');
});

it('keeps every other rule inside the root, including resets', () => {
  expect(scopeSelector('*')).toBe('.nexus-scanner-root *');
  expect(scopeSelector('button:disabled')).toBe('.nexus-scanner-root button:disabled');
  expect(scopeSelector('.htmlish')).toBe('.nexus-scanner-root .htmlish');
  expect(scopeSelector('.is-resizing-docked')).toBe('.nexus-scanner-root .is-resizing-docked');
});

it('leaves keyframes and nested rules alone and merges duplicates', () => {
  const css = scopeCss(`@layer theme{:root,:host{--a:1}}@keyframes spin{from{opacity:0}to{opacity:1}}
.a{color:red;&:hover{color:blue}}@media (prefers-color-scheme:dark){:root:not([data-theme]){color:white}}`);
  expect(css).toContain('@layer theme{.nexus-scanner-root{--a:1}}');
  expect(css).toContain('@keyframes spin{from{opacity:0}to{opacity:1}}');
  expect(css).toContain('.nexus-scanner-root .a{color:red;&:hover{color:blue}}');
  expect(css).toContain('.nexus-scanner-root:not([data-theme]){color:white}');
});
