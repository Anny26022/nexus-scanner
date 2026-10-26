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

const css = postcss.parse(readFileSync(path.join(dist, 'style.css'), 'utf8'));
const nested = rule => {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'rule' || (parent.type === 'atrule' && /keyframes$/i.test(parent.name))) return true;
  }
  return false;
};
css.walkRules(rule => {
  if (nested(rule)) return;
  for (const selector of rule.selectors) {
    if (!selector.startsWith('.nexus-scanner-root')) failures.push(`unscoped CSS selector: ${selector}`);
  }
});

const scripts = readdirSync(dist).filter(file => file.endsWith('.js')).map(file => readFileSync(path.join(dist, file), 'utf8'));
if (scripts.some(code => /new Worker\(\s*new URL\(/.test(code))) failures.push('a worker is loaded from a file URL instead of being inlined');
for (const name of ['snapshotWorkerFactory.inline.ts', 'studyWorkerFactory.inline.ts']) {
  if (!scripts.some(code => code.includes(name))) failures.push(`inline worker ${name} is missing from the bundle`);
}

if (failures.length) {
  console.error(`Library check failed:\n- ${[...new Set(failures)].slice(0, 20).join('\n- ')}`);
  process.exit(1);
}
console.log('Library check passed: scoped CSS, inline workers, exports present.');
