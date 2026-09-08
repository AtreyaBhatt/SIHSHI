/**
 * MV3 service worker: orchestration and (from M4) the only place network calls
 * live. In M1 it does two things — inject the capture script and grab the
 * screenshot — and sends nothing anywhere.
 *
 * NOTE for M3: pixel redaction belongs here, not in the content script.
 * OffscreenCanvas is available in the worker, so blur/box compositing runs off
 * the page's main thread. PRD §6.2.1 names `chrome.tabCapture`; that returns a
 * MediaStream and needs a user gesture in a document context. For a still
 * screenshot `chrome.tabs.captureVisibleTab` is the correct API and works
 * directly from here.
 */
import { api, isRestrictedUrl } from '../shared/browser';
import type { CaptureResult } from '../shared/schema';
import type { ContentToWorker, PayloadPreview, PopupToWorker, WorkerReply } from '../shared/messages';
import { buildAgentRequest } from '../redaction/build-request';
import { TokenRegistry, newSessionId } from '../redaction/tokens';

/**
 * The cached capture holds a raw snapshot with real values. chrome.storage.session
 * is memory-backed and not written to disk, and it is unreadable from content
 * scripts, so this stays inside the same trust boundary as the worker itself —
 * do not switch it to storage.local, which would put page values on disk.
 */
const LAST_CAPTURE_KEY = 'ppva:last-capture';

/** Kept in worker memory so the popup can reopen without re-capturing; session storage is best-effort. */
let lastCapture: CaptureResult | null = null;

/**
 * Token registry and session id live here and only here. Never persisted:
 * a token that survived its session would become the stable pseudonym PRD §9.4
 * exists to prevent.
 */
let tokens = new TokenRegistry(newSessionId());

function resetSession(): string {
  tokens = new TokenRegistry(newSessionId());
  return tokens.session_id;
}

async function buildPayload(threshold: number, taskInstruction: string): Promise<PayloadPreview> {
  if (!lastCapture) throw new Error('Nothing captured yet.');
  const started = performance.now();
  try {
    const { request, detections } = await buildAgentRequest({
      snapshot: lastCapture.snapshot,
      screenshotDataUrl: lastCapture.screenshot_data_url,
      taskInstruction,
      tokens,
      threshold,
    });
    return {
      session_id: tokens.session_id,
      request,
      detections,
      build_ms: Math.round((performance.now() - started) * 100) / 100,
      error: null,
    };
  } catch (err) {
    // Fail closed: no payload leaves this function when redaction could not be
    // verified, and the viewer surfaces why.
    return {
      session_id: tokens.session_id,
      request: null,
      detections: [],
      build_ms: Math.round((performance.now() - started) * 100) / 100,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runCapture(): Promise<CaptureResult> {
  const total0 = performance.now();

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  if (isRestrictedUrl(tab.url)) {
    throw new Error(`Cannot capture a browser-internal page (${tab.url ?? 'unknown'}). Open a normal http(s) page.`);
  }
  const tabId = tab.id;

  await api.scripting.executeScript({
    target: { tabId },
    files: ['capture/content-script.js'],
  });

  const domResponse = (await api.tabs.sendMessage(tabId, { type: 'ppva:capture-dom' })) as ContentToWorker;
  if (!domResponse?.ok) throw new Error(domResponse?.error ?? 'Content script returned no snapshot.');
  const snapshot = domResponse.snapshot;

  // Screenshot is best-effort: a snapshot without pixels is still useful for the
  // DOM-heuristic detectors, so a capture failure here must not lose the walk.
  const shot0 = performance.now();
  let screenshotDataUrl: string | null = null;
  let screenshotError: string | null = null;
  try {
    screenshotDataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    screenshotError = err instanceof Error ? err.message : String(err);
  }
  const screenshotMs = performance.now() - shot0;

  const result: CaptureResult = {
    snapshot,
    screenshot_data_url: screenshotDataUrl,
    screenshot_error: screenshotError,
    timings: {
      dom_walk_ms: snapshot.timings.dom_walk_ms,
      screenshot_ms: Math.round(screenshotMs * 100) / 100,
      total_ms: Math.round((performance.now() - total0) * 100) / 100,
    },
  };

  lastCapture = result;
  try {
    await api.storage.session.set({ [LAST_CAPTURE_KEY]: result });
  } catch {
    // Screenshots can exceed the session-storage quota; memory copy still stands.
  }
  return result;
}

async function getLastCapture(): Promise<CaptureResult | null> {
  if (lastCapture) return lastCapture;
  try {
    const stored = await api.storage.session.get(LAST_CAPTURE_KEY);
    lastCapture = (stored?.[LAST_CAPTURE_KEY] as CaptureResult | undefined) ?? null;
  } catch {
    lastCapture = null;
  }
  return lastCapture;
}

api.runtime.onMessage.addListener(
  (message: PopupToWorker, _sender, sendResponse: (r: WorkerReply<never>) => void) => {
    const fail = (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });

    const ok = (data: unknown) => sendResponse({ ok: true, data } as WorkerReply<never>);

    if (message?.type === 'ppva:run-capture') {
      runCapture().then(ok).catch(fail);
      return true; // async
    }
    if (message?.type === 'ppva:get-last-capture') {
      getLastCapture().then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'ppva:build-payload') {
      buildPayload(message.threshold, message.task_instruction).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'ppva:reset-session') {
      ok({ session_id: resetSession() });
      return false;
    }
    return false;
  },
);
