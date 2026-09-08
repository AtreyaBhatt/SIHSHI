/**
 * Thin shim over the extension APIs we use.
 *
 * PRD §13 Q1 is answered "Chrome-only for the demo" — but every `chrome.*` call
 * goes through here so a Firefox port is a swap of this file rather than a sweep
 * of the codebase. Firefox's `browser.*` namespace is promise-based already;
 * Chrome's MV3 APIs are too, so the shim stays this small.
 */

declare const browser: typeof chrome | undefined;

export const api: typeof chrome =
  typeof browser !== 'undefined' && browser ? (browser as typeof chrome) : chrome;

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return /^(chrome|edge|about|moz-extension|chrome-extension|devtools|view-source):/i.test(url)
    || url.startsWith('https://chrome.google.com/webstore')
    || url.startsWith('https://chromewebstore.google.com');
}
