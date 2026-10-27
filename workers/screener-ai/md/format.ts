import { absolute } from './site';

/** Text that markdown would otherwise read as syntax. */
export const escapeText = (text: string) => text.replace(/([\\`*_[\]<>|])/g, '\\$1');

export const link = (text: string, path: string) => `[${escapeText(text)}](${path.startsWith('http') ? path : absolute(path)})`;

export const list = (items: readonly string[]) => items.map(item => `- ${item}`).join('\n');

export function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.map(cell => escapeText(String(cell))).join(' | ')} |`;
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

export const number = (value: number, digits = 0) => value.toLocaleString('en-IN', {maximumFractionDigits: digits});
export const signed = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;

/** A markdown page in the site's one layout: title, summary, canonical, date, body, related links. */
export interface Page { title: string; summary: string; path: string; updated?: string; body: string; related?: readonly [string, string][] }

export function renderPage(page: Page): string {
  return [
    `# ${page.title}`,
    `> ${page.summary}`,
    [`Canonical: ${absolute(page.path)}`, page.updated && `Last updated: ${page.updated}`].filter(Boolean).join('\n'),
    page.body.trim(),
    page.related?.length ? `## Related\n${list(page.related.map(([text, path]) => link(text, path)))}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}
