/**
 * Content script entry. Injected on demand by the service worker when the user
 * clicks Capture — not declared statically — so the extension holds no standing
 * access to any page. `activeTab` grants access for one tab, on one gesture.
 *
 * This script only ever reads. It installs no observers in M1; the
 * MutationObserver-gated trigger (PRD §6.2.5) arrives with the agent loop.
 */
import { captureDomSnapshot } from './dom-snapshot';
import { executeActions } from '../executor/execute';
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
      const fail = (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });

      if (message?.type === 'ppva:capture-dom') {
        try {
          sendResponse({ ok: true, snapshot: captureDomSnapshot() });
        } catch (err) {
          fail(err);
        }
        return false; // responded synchronously
      }

      if (message?.type === 'ppva:execute') {
        // Values arrive already resolved from the local vault; they are used here
        // and never travel any further.
        executeActions(message.actions, message.allowed_selectors)
          .then((outcomes) => sendResponse({ ok: true, outcomes }))
          .catch(fail);
        return true; // async
      }

      return false;
    },
  );
}
