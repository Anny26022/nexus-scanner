import postcss, {type Rule} from 'postcss';

/**
 * Library CSS only: every rule is confined to `.nexus-scanner-root`, so the package's Tailwind preflight, element
 * defaults and design tokens never reach the host page. Document-level selectors (`:root`, `:host`, `html`, `body`)
 * become the root itself; everything else must sit inside a root (the app frame or the body-level portal container).
 */
export const ROOT = '.nexus-scanner-root';
// Classes the app toggles on the root element itself (standalone: on <html>).
const ROOT_STATE_CLASSES = ['.is-resizing-dock'];
const DOCUMENT = /^(?::root|:host|html|body)(?![\w-])/;

export function scopeSelector(selector: string): string {
  const trimmed = selector.trim();
  if (DOCUMENT.test(trimmed)) {
    // `:root, :host` and `html` collapse to the root; a following compound or descendant part is kept.
    return trimmed.replace(DOCUMENT, ROOT);
  }
  if (ROOT_STATE_CLASSES.some(name => trimmed.startsWith(name) && !/[\w-]/.test(trimmed[name.length] ?? ''))) {
    return `${ROOT}${trimmed}`;
  }
  return `${ROOT} ${trimmed}`;
}

// Keyframe steps are not selectors, and a nested rule is already scoped through its outer rule.
const skipped = (rule: Rule) => {
  for (let parent: postcss.Node | undefined = rule.parent as postcss.Node | undefined; parent; parent = parent.parent as postcss.Node | undefined) {
    if (parent.type === 'rule') return true;
    if (parent.type === 'atrule' && /keyframes$/i.test((parent as postcss.AtRule).name)) return true;
  }
  return false;
};

export function scopeCss(css: string): string {
  const root = postcss.parse(css);
  root.walkRules(rule => {
    if (skipped(rule)) return;
    rule.selectors = [...new Set(rule.selectors.map(scopeSelector))];
  });
  return root.toString();
}
