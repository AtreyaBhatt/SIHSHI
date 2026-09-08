/**
 * Content script entry. Injected on demand by the service worker when the user
 * clicks Capture — not declared statically — so the extension holds no standing
 * access to any page. `activeTab` grants access for one tab, on one gesture.
 *
 * This script only ever reads. It installs no observers in M1; the
 * MutationObserver-gated trigger (PRD §6.2.5) arrives with the agent loop.
 */
import { captureDomSnapshot } from './dom-snapshot';
import type { ContentToWorker, WorkerToContent } from '../shared/messages';

declare global {
  interface Window {
    __PPVA_INSTALLED__?: true;
  }
}

if (!window.__PPVA_INSTALLED__) {
  window.__PPVA_INSTALLED__ = true;

  chrome.runtime.onMessage.addListener(
    (message: WorkerToContent, _sender, sendResponse: (r: ContentToWorker) => void) => {
      if (message?.type !== 'ppva:capture-dom') return false;
      try {
        sendResponse({ ok: true, snapshot: captureDomSnapshot() });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false; // responded synchronously
    },
  );
}
