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
    __ATHENA_INSTALLED__?: true;
  }
}

if (!window.__ATHENA_INSTALLED__) {
  window.__ATHENA_INSTALLED__ = true;

  chrome.runtime.onMessage.addListener(
    (message: WorkerToContent, _sender, sendResponse: (r: ContentToWorker) => void) => {
      const fail = (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });

      if (message?.type === 'athena:capture-dom') {
        try {
          sendResponse({ ok: true, snapshot: captureDomSnapshot() });
        } catch (err) {
          fail(err);
        }
        return false; // responded synchronously
      }

      if (message?.type === 'athena:execute') {
        // Values arrive already resolved from the local vault; they are used here
        // and never travel any further.
        executeActions(message.actions, message.allowed_selectors, message.expected_origin)
          .then((outcomes) => sendResponse({ ok: true, outcomes }))
          .catch(fail);
        return true; // async
      }

      if (message?.type === 'athena:settle') {
        // Quiet for 500 ms or 3 s hard cap — enough for SPA re-renders after a click.
        const QUIET_MS = 500; const MAX_MS = 3000;
        let timer = window.setTimeout(finish, QUIET_MS);
        const hard = window.setTimeout(finish, MAX_MS);
        const observer = new MutationObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(finish, QUIET_MS); });
        observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
        function finish(): void { observer.disconnect(); window.clearTimeout(timer); window.clearTimeout(hard); sendResponse({ ok: true, settled: true }); }
        return true;
      }

      return false;
    },
  );
}
