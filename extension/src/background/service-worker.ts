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
import type {
  ContentToWorker, ExecutionResult, HealthReport, PayloadPreview, PlanPreview, PopupToWorker, WorkerReply,
} from '../shared/messages';
import type { AgentAction, AgentRequest, AgentResponse } from '../shared/schema';
import type { ExecutableAction } from '../executor/execute';
import { buildAgentRequest } from '../redaction/build-request';
import { TokenRegistry, newSessionId } from '../redaction/tokens';
import { checkHealth, getServerUrl, requestPlan } from './agent-client';
import { resolveValueRef } from '../shared/vault';

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

/** Multi-turn history for PRD §7.1. Verbs and selectors only — never a result. */
let priorActions: AgentAction[] = [];

/** The plan the user may execute. Held only until the next plan replaces it. */
let lastPlan: { request: AgentRequest; response: AgentResponse } | null = null;

function resetSession(): string {
  tokens = new TokenRegistry(newSessionId());
  priorActions = [];
  lastPlan = null;
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
      priorActions,
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
  if (!domResponse?.ok || !('snapshot' in domResponse)) {
    throw new Error(
      domResponse && 'error' in domResponse ? domResponse.error : 'Content script returned no snapshot.',
    );
  }
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

/**
 * Capture → redact → send → plan. The only path that reaches the network, and it
 * runs through buildAgentRequest first by construction: requestPlan's parameter
 * type is the one that function alone produces.
 */
async function requestPlanFlow(threshold: number, taskInstruction: string): Promise<PlanPreview> {
  const preview = await buildPayload(threshold, taskInstruction);
  if (!preview.request) {
    return { preview, response: null, network_ms: 0, error: preview.error ?? 'No payload was built.' };
  }

  const started = performance.now();
  try {
    const response = await requestPlan(preview.request);
    lastPlan = { request: preview.request, response };
    return {
      preview,
      response,
      network_ms: Math.round((performance.now() - started) * 100) / 100,
      error: null,
    };
  } catch (err) {
    lastPlan = null;
    return {
      preview,
      response: null,
      network_ms: Math.round((performance.now() - started) * 100) / 100,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolves value_refs locally, then hands concrete values to the content script.
 * This is the only moment a secret exists outside the vault, and it never leaves
 * the extension: the server named the slot, the browser filled it.
 */
async function executePlanFlow(): Promise<ExecutionResult> {
  if (!lastPlan) throw new Error('No plan to execute — request one first.');

  const actions: ExecutableAction[] = [];
  for (const action of lastPlan.response.actions) {
    const executable: ExecutableAction = { action: action.action };
    if (action.selector) executable.selector = action.selector;
    if (action.value_ref) {
      executable.value = await resolveValueRef(action.value_ref);
      executable.value_ref = action.value_ref;
    } else if (action.value !== undefined) {
      executable.value = action.value;
    }
    actions.push(executable);
  }

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/content-script.js'] });

  const started = performance.now();
  const reply = (await api.tabs.sendMessage(tab.id, {
    type: 'ppva:execute',
    actions,
    allowed_selectors: lastPlan.request.dom_summary.map((node) => node.path),
  })) as ContentToWorker;

  if (!reply?.ok || !('outcomes' in reply)) {
    throw new Error(reply && 'error' in reply ? reply.error : 'Executor returned nothing.');
  }

  // Only what was attempted, never what was read or typed.
  priorActions = [...priorActions, ...lastPlan.response.actions];

  return {
    outcomes: reply.outcomes,
    execute_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

async function health(): Promise<HealthReport> {
  const report = await checkHealth();
  return { ...report, server_url: await getServerUrl() };
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
    if (message?.type === 'ppva:request-plan') {
      requestPlanFlow(message.threshold, message.task_instruction).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'ppva:execute-plan') {
      executePlanFlow().then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'ppva:check-health') {
      health().then(ok).catch(fail);
      return true;
    }
    return false;
  },
);
