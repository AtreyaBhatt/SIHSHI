/**
 * The only way a snapshot path becomes an element again.
 *
 * Paths are CSS selectors, except that ` >>> ` separates shadow-root hops:
 * `div#widget >>> input#inner-email` means "resolve `div#widget` in the
 * current root, step into its open shadow root, resolve `input#inner-email`
 * there". `querySelector` cannot cross a shadow boundary, so every consumer —
 * executor, harnesses, the corpus measurer — goes through this function.
 *
 * Returns every match of the final segment so callers can insist on exactly one.
 * An ambiguous or missing host on the way returns the host matches (or nothing)
 * so the caller's "must be exactly one" check fails with a useful count.
 */
export const SHADOW_SEP = ' >>> ';

export function resolvePath(path: string, root: ParentNode = document): Element[] {
  const segments = path.split(SHADOW_SEP);
  let scope: ParentNode = root;
  for (let i = 0; i < segments.length; i++) {
    let matches: Element[];
    try {
      matches = Array.from(scope.querySelectorAll(segments[i]!));
    } catch {
      return [];
    }
    if (i === segments.length - 1) return matches;
    if (matches.length !== 1) return matches;
    const shadow = matches[0]!.shadowRoot;
    if (!shadow) return [];
    scope = shadow;
  }
  return [];
}
