// Checks the library build in dist-lib/ before it can be packed: the stylesheet never styles anything outside
// `.nexus-scanner-root`, both workers are inlined, and every file the package exports exists.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist-lib');
const failures = [];

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const targets = Object.values(pkg.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value));
for (const target of [pkg.module, pkg.types, ...targets]) {
  if (!existsSync(path.join(root, target))) failures.push(`missing exported file ${target}`);
}

const nested = rule => {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'rule' || (parent.type === 'atrule' && /keyframes$/i.test(parent.name))) return true;
  }
  return false;
};
for (const sheet of ['style.css', 'charts/charts.css']) {
  postcss.parse(readFileSync(path.join(dist, sheet), 'utf8')).walkRules(rule => {
    if (nested(rule)) return;
    for (const selector of rule.selectors) {
      if (!selector.startsWith('.nexus-scanner-root')) failures.push(`unscoped CSS selector in ${sheet}: ${selector}`);
    }
  });
}

const read = dir => readdirSync(dir).filter(file => file.endsWith('.js')).map(file => readFileSync(path.join(dir, file), 'utf8'));
const scripts = read(dist);
const chartScripts = read(path.join(dist, 'charts'));
if ([...scripts, ...chartScripts].some(code => /new Worker\(\s*new URL\(/.test(code))) failures.push('a worker is loaded from a file URL instead of being inlined');
if (!chartScripts.some(code => code.includes('studyWorkerFactory.inline.ts'))) failures.push('the charts entry does not inline the study worker');
// The charts entry must stay small: no app shell, no React Query, no scanner data layer.
for (const name of ['@tanstack/react-query', 'ScannerShell', 'snapshotWorkerFactory']) {
  if (chartScripts.some(code => code.includes(name))) failures.push(`the charts entry pulls in ${name}`);
}
for (const name of ['snapshotWorkerFactory.inline.ts', 'studyWorkerFactory.inline.ts']) {
  if (!scripts.some(code => code.includes(name))) failures.push(`inline worker ${name} is missing from the bundle`);
}

if (failures.length) {
  console.error(`Library check failed:\n- ${[...new Set(failures)].slice(0, 20).join('\n- ')}`);
  process.exit(1);
}
console.log('Library check passed: scoped CSS, inline workers, exports present, charts entry self-contained.');
