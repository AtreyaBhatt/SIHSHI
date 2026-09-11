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
  ContentToWorker, ExecutionResult, HealthReport, PanelToWorker, PayloadPreview, PlanPreview, WorkerReply,
} from '../shared/messages';
import type { AgentAction, AgentRequest, AgentResponse } from '../shared/schema';
import type { ExecutableAction } from '../executor/execute';
import { buildAgentRequest } from '../redaction/build-request';
import { TokenRegistry, newSessionId } from '../redaction/tokens';
import { checkHealth, getServerUrl, requestPlan } from './agent-client';
import { resolveValueRef } from '../shared/vault';
import type { FaceDetection } from '../perception/face-detect';
import type { DetectFacesReply } from '../perception/offscreen';

/**
 * The cached capture holds a raw snapshot with real values. chrome.storage.session
 * is memory-backed and not written to disk, and it is unreadable from content
 * scripts, so this stays inside the same trust boundary as the worker itself —
 * do not switch it to storage.local, which would put page values on disk.
 */
const LAST_CAPTURE_KEY = 'athena:last-capture';
/** Same store, same reasoning; the plan holds only the sanitized request and the server's reply. */
const LAST_PLAN_KEY = 'athena:last-plan';

/**
 * Kept in worker memory so the panel can reopen without re-capturing; session
 * storage is best-effort, and the panel outlives enough tab switches to notice.
 */
let lastCapture: CaptureResult | null = null;

/**
 * Token registry and session id live here and only here. Never persisted:
 * a token that survived its session would become the stable pseudonym PRD §9.4
 * exists to prevent.
 */
let tokens = new TokenRegistry(newSessionId());

/** Multi-turn history for PRD §7.1. Verbs and selectors only — never a result. */
let priorActions: AgentAction[] = [];

/**
 * The plan the user may execute. Held only until the next plan replaces it.
 * Mirrored to session storage because the worker is routinely suspended while
 * the user reads the approval prompt, and "No plan to execute" thirty seconds
 * after a plan was shown is not an acceptable answer.
 */
interface StoredPlan { request: AgentRequest; response: AgentResponse; tab_id: number; page_url: string }
let lastPlan: StoredPlan | null = null;

async function setLastPlan(plan: StoredPlan | null): Promise<void> {
  lastPlan = plan;
  try {
    if (plan) await api.storage.session.set({ [LAST_PLAN_KEY]: plan });
    else await api.storage.session.remove(LAST_PLAN_KEY);
  } catch {
    // Memory copy still stands.
  }
}

async function getLastPlan(): Promise<StoredPlan | null> {
  if (lastPlan) return lastPlan;
  try {
    const stored = await api.storage.session.get(LAST_PLAN_KEY);
    lastPlan = (stored?.[LAST_PLAN_KEY] as StoredPlan | undefined) ?? null;
  } catch {
    lastPlan = null;
  }
  return lastPlan;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function resetSession(): string {
  tokens = new TokenRegistry(newSessionId());
  priorActions = [];
  void setLastPlan(null);
  return tokens.session_id;
}

const OFFSCREEN_PATH = 'perception/offscreen.html';
let offscreenReady: Promise<void> | null = null;

/**
 * Creates the perception document once and reuses it, so the ONNX session and
 * its 13 MB wasm binary are initialised a single time per worker lifetime
 * rather than per capture. Session init is ~235 ms; inference is ~30 ms.
 */
async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
    if (existing.length > 0) return;
    await api.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Runs the local face detector (ONNX Runtime Web) off the visited page.',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

/**
 * Best-effort by design: a page with no faces, an absent model file, or a
 * machine where the runtime will not start must not cost the user their text
 * redaction. Failures are reported, not thrown.
 */
async function detectFaces(capture: CaptureResult): Promise<{ faces: FaceDetection[]; note: string | null }> {
  if (!capture.screenshot_data_url) return { faces: [], note: 'no screenshot to scan' };
  try {
    await ensureOffscreen();
    // Frames are black-boxed unconditionally (build-request emits a `frame`
    // entry), so scanning their pixels for faces is inference spent on a
    // region that is already gone.
    const regions = capture.snapshot.nodes.filter((n) => n.media && n.media !== 'iframe').map((n) => n.bbox);
    const reply = (await api.runtime.sendMessage({
      type: 'athena:detect-faces',
      screenshot_data_url: capture.screenshot_data_url,
      regions,
      viewport_width: capture.snapshot.viewport.width,
    })) as DetectFacesReply;

    if (!reply?.ok) return { faces: [], note: reply?.error ?? 'face detector returned nothing' };
    return {
      faces: reply.faces,
      note: `${reply.faces.length} face(s) · ${reply.provider} · ${reply.inference_ms} ms`,
    };
  } catch (err) {
    return { faces: [], note: err instanceof Error ? err.message : String(err) };
  }
}

async function buildPayload(capture: CaptureResult, threshold: number, taskInstruction: string): Promise<PayloadPreview> {
  const started = performance.now();
  try {
    const { faces, note } = await detectFaces(capture);
    const { request, detections } = await buildAgentRequest({
      snapshot: capture.snapshot,
      screenshotDataUrl: capture.screenshot_data_url,
      taskInstruction,
      tokens,
      threshold,
      priorActions,
      faces,
    });
    return {
      session_id: tokens.session_id,
      request,
      detections,
      build_ms: Math.round((performance.now() - started) * 100) / 100,
      perception_note: note,
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
      perception_note: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function targetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) return api.tabs.get(tabId);
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  return tab;
}

async function runCapture(requestedTabId?: number): Promise<CaptureResult> {
  const total0 = performance.now();

  const tab = await targetTab(requestedTabId);
  if (!tab?.id) throw new Error('No active tab.');
  if (tab.url === undefined) {
    // activeTab was granted for a different tab, or has lapsed because this one
    // navigated. Without it we cannot even read the URL, let alone inject.
    throw new Error(
      'ATHENA has no access to this tab. Click the ATHENA toolbar icon on the page (one-off), or enable ATHENA on the site from the panel (persistent).',
    );
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(`Cannot capture a browser-internal page (${tab.url}). Open a normal http(s) page.`);
  }
  const tabId = tab.id;

  await api.scripting.executeScript({
    target: { tabId },
    files: ['capture/content-script.js'],
  });

  const domResponse = (await api.tabs.sendMessage(tabId, { type: 'athena:capture-dom' })) as ContentToWorker;
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
    tab_id: tabId,
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
  const capture = await getLastCapture();
  if (!capture) throw new Error('Nothing captured yet.');
  const preview = await buildPayload(capture, threshold, taskInstruction);
  if (!preview.request) {
    return { preview, response: null, network_ms: 0, error: preview.error ?? 'No payload was built.' };
  }

  const started = performance.now();
  try {
    const response = await requestPlan(preview.request);
    await setLastPlan({ request: preview.request, response, tab_id: capture.tab_id, page_url: capture.snapshot.page_url });
    return {
      preview,
      response,
      network_ms: Math.round((performance.now() - started) * 100) / 100,
      error: null,
    };
  } catch (err) {
    await setLastPlan(null);
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
async function executePlanFlow(tabId?: number): Promise<ExecutionResult> {
  const plan = await getLastPlan();
  if (!plan) throw new Error('No plan to execute — request one first.');

  // The plan was made for one page in one tab. The user may have switched tabs
  // or the page may have redirected since; typing a resolved credential into
  // whatever is there now is exactly the leak this project exists to prevent.
  const tab = await targetTab(tabId ?? plan.tab_id);
  if (!tab?.id) throw new Error('No active tab.');
  if (!tab.url || originOf(tab.url) !== originOf(plan.page_url)) {
    throw new Error('The page changed since it was captured — capture and plan again before executing.');
  }

  const actions: ExecutableAction[] = [];
  for (const action of plan.response.actions) {
    const executable: ExecutableAction = { action: action.action };
    if (action.selector) executable.selector = action.selector;
    if (action.value_ref) {
      executable.value = await resolveValueRef(action.value_ref);
      executable.value_ref = action.value_ref;
    } else if (typeof action.value === 'string') {
      // JSON round-trips absence as null, not undefined.
      executable.value = action.value;
    }
    actions.push(executable);
  }

  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/content-script.js'] });

  const started = performance.now();
  const reply = (await api.tabs.sendMessage(tab.id, {
    type: 'athena:execute',
    actions,
    allowed_selectors: plan.request.dom_summary.map((node) => node.path),
  })) as ContentToWorker;

  if (!reply?.ok || !('outcomes' in reply)) {
    throw new Error(reply && 'error' in reply ? reply.error : 'Executor returned nothing.');
  }

  // Only what was attempted, never what was read or typed.
  priorActions = [...priorActions, ...plan.response.actions];

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
  (message: PanelToWorker, _sender, sendResponse: (r: WorkerReply<never>) => void) => {
    const fail = (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });

    const ok = (data: unknown) => sendResponse({ ok: true, data } as WorkerReply<never>);

    if (message?.type === 'athena:run-capture') {
      runCapture(message.tab_id).then(ok).catch(fail);
      return true; // async
    }
    if (message?.type === 'athena:get-last-capture') {
      getLastCapture().then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:build-payload') {
      getLastCapture()
        .then((capture) => {
          if (!capture) throw new Error('Nothing captured yet.');
          return buildPayload(capture, message.threshold, message.task_instruction);
        })
        .then(ok)
        .catch(fail);
      return true;
    }
    if (message?.type === 'athena:reset-session') {
      ok({ session_id: resetSession() });
      return false;
    }
    if (message?.type === 'athena:request-plan') {
      requestPlanFlow(message.threshold, message.task_instruction).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:execute-plan') {
      executePlanFlow(message.tab_id).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:check-health') {
      health().then(ok).catch(fail);
      return true;
    }
    return false;
  },
);

/**
 * Bind the toolbar icon to the panel.
 *
 * MV3 has no manifest key for "this extension's UI is a side panel" the way
 * `action.default_popup` declares a popup, so the association is made at runtime.
 * `setPanelBehavior` is idempotent and cheap, and the worker is torn down and
 * restarted freely, so this runs on every start: that is also what makes the
 * binding survive an extension reload or an update.
 */
if (api.sidePanel) {
  api.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[athena] could not bind the toolbar icon to the side panel:', err));
} else {
  console.warn('[athena] chrome.sidePanel is unavailable; open the panel from the side-panel picker.');
}
