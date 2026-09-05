/**
 * The renderer's half of the theme.
 *
 * Main computes the three switches and pushes them; this writes them onto
 * `<html>` as data attributes and the token sheet does the rest. No colour
 * is chosen here — that would put a second colour authority in the app and
 * defeat the locality rule that makes "is there any green in this product"
 * a one-file question.
 *
 * The type is imported with `import type`, so `verbatimModuleSyntax` erases
 * it entirely and no main-process module (and therefore no `electron`) can
 * reach the renderer bundle.
 */
import type { ThemePayload } from '../../main/theme.js';

/**
 * `off` is written explicitly rather than the attribute being removed.
 *
 * "Reduced transparency is off" and "main has not told us yet" are different
 * states, and a renderer that cannot tell them apart cannot decide whether a
 * first paint is trustworthy.
 */
export function applyTheme(theme: ThemePayload): void {
  const root = document.documentElement;
  root.dataset['reducedTransparency'] = theme.reducedTransparency
    ? 'on'
    : 'off';
  root.dataset['colorScheme'] = theme.dark ? 'dark' : 'light';
  root.dataset['reducedMotion'] = theme.reducedMotion ? 'on' : 'off';
}

/** Narrow an unknown push payload to a theme, or `null` if it is not one. */
export function asTheme(payload: unknown): ThemePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  return typeof p['dark'] === 'boolean' &&
    typeof p['reducedTransparency'] === 'boolean' &&
    typeof p['reducedMotion'] === 'boolean'
    ? (payload as ThemePayload)
    : null;
}
