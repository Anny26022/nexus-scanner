/**
 * Where the app keeps its theme and floating surfaces. Standalone, that is the document itself. Embedded in a
 * host page, the scanner's root element carries `data-theme` and the scoped tokens, and dialogs, popovers and
 * cards render into one body-level container that carries the same scope class, so nothing touches the host's
 * `<html>` or `<body>` styling.
 */
export const EMBED_ROOT_CLASS = 'nexus-scanner-root';

let themeRoot: HTMLElement | null = null;
let portalRoot: HTMLElement | null = null;

export function setEmbedRoots(roots: {theme: HTMLElement; portal: HTMLElement} | null) {
  themeRoot = roots?.theme ?? null;
  portalRoot = roots?.portal ?? null;
}

/** The element whose `data-theme` and CSS tokens the app reads. */
export const themeElement = (): HTMLElement => themeRoot ?? document.documentElement;

/** The container for portalled UI: undefined standalone, so Radix and React keep their default of `document.body`. */
export const portalContainer = (): HTMLElement | undefined => portalRoot ?? undefined;
