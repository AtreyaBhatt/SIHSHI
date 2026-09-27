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
import type { AgentAction, AgentRequest, AgentResponse, PriorAction } from '../shared/schema';
import type { ActionOutcome, ExecutableAction, ExecutableVerb } from '../executor/execute';
import { splitAtTabVerb } from '../shared/plan-split';
import { assertNoTypedSecrets, buildAgentRequest, RawPiiLeakError } from '../redaction/build-request';
import type { FirewallReport } from '../redaction/firewall';
import { TokenRegistry, newSessionId, type RegistryJSON } from '../redaction/tokens';
import { getProviderStatus, requestPlan } from './agent-client';
import {
  VaultError, VaultLockedError, createVault, deleteSlot, lockVault, resolveValueRef, setProviderApiKey, setSlot, unlockVault, vaultSlotRefs, vaultStatus,
} from '../shared/vault';
import type { FaceDetection } from '../perception/face-detect';
import type { DetectFacesReply } from '../perception/offscreen';
import {
  approve, drive, newRun, stop, type Run, type RunStatus,
} from './agent/loop';
import { DEFAULT_THRESHOLD } from '../pii-detection/detect';

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
let priorActions: PriorAction[] = [];

/**
 * Selectors and values of credentials typed via value_ref, keyed by the run id
 * (loop) or session id (single step) — the registry's session_id either way.
 * Worker memory only: never stored, logged, quoted in an error, or sent. The
 * paths are forced to Tier 1 on the next capture; the values are the egress
 * check's needles.
 */
const typedSecretPaths = new Map<string, Set<string>>();
const typedSecretValues = new Map<string, Set<string>>();

function forgetTypedSecrets(key: string): void {
  typedSecretPaths.delete(key);
  typedSecretValues.delete(key);
}

function rememberTypedSecret(key: string, selector: string | undefined, value: string): void {
  const add = (map: Map<string, Set<string>>, item: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(item);
  };
  if (selector) add(typedSecretPaths, selector);
  if (value) add(typedSecretValues, value);
}

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

/**
 * Mirrors a token registry to chrome.storage.session, keyed by its session id,
 * so a service-worker restart mid-session can rebuild it instead of starting
 * token numbering (and the id→value map a typed token needs) over from zero.
 * storage.session is memory-backed and browser-session scoped — it is never
 * written to disk and is gone when the browser session ends, which is what
 * keeps this consistent with PRD §9.4. Never mirror to storage.local.
 */
const REGISTRY_KEY = (id: string) => `athena:registry:${id}`;

async function saveRegistry(registry: TokenRegistry): Promise<void> {
  try {
    await api.storage.session.set({ [REGISTRY_KEY(registry.session_id)]: registry.toJSON() });
  } catch {
    // Memory copy stands.
  }
}

async function loadRegistry(id: string): Promise<TokenRegistry | null> {
  try {
    const key = REGISTRY_KEY(id);
    const stored = (await api.storage.session.get(key))?.[key] as RegistryJSON | undefined;
    return stored ? TokenRegistry.from(stored) : null;
  } catch {
    return null;
  }
}

async function dropRegistry(id: string): Promise<void> {
  try {
    await api.storage.session.remove(REGISTRY_KEY(id));
  } catch {
    // Nothing to drop.
  }
}

function resetSession(): string {
  forgetTypedSecrets(tokens.session_id);
  void dropRegistry(tokens.session_id);
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

/**
 * Demo-only switch: names of detectors (DomRule/PatternRule `detector`, e.g.
 * `regex:email`) that `detectPii` skips this pass, so the independent firewall
 * scan (`redaction/firewall.ts`) is the one that catches the value instead —
 * proof it works, not a way to make it optional. Never read by the firewall.
 */
const DEBUG_DISABLED_DETECTORS_KEY = 'athena:debug-disabled-detectors';

async function readDisabledDetectors(): Promise<Set<string> | undefined> {
  try {
    const stored = (await api.storage.local.get(DEBUG_DISABLED_DETECTORS_KEY))?.[
      DEBUG_DISABLED_DETECTORS_KEY
    ] as string[] | undefined;
    return stored && stored.length > 0 ? new Set(stored) : undefined;
  } catch {
    return undefined;
  }
}

async function buildPayload(
  capture: CaptureResult,
  threshold: number,
  taskInstruction: string,
  registry: TokenRegistry,
  history: PriorAction[],
): Promise<PayloadPreview> {
  const started = performance.now();
  try {
    const { faces, note } = await detectFaces(capture);
    const { request, detections, firewall } = await buildAgentRequest({
      snapshot: capture.snapshot,
      screenshotDataUrl: capture.screenshot_data_url,
      taskInstruction,
      tokens: registry,
      threshold,
      disabledDetectors: await readDisabledDetectors(),
      priorActions: history,
      faces,
      forceTier1Paths: typedSecretPaths.get(registry.session_id),
      typedSecretValues: typedSecretValues.get(registry.session_id),
      availableRefs: await vaultSlotRefs(), // names only; [] while locked
    });
    await saveRegistry(registry);
    assertNoTypedSecrets(request, typedSecretValues.get(registry.session_id) ?? []);
    return {
      session_id: registry.session_id,
      request,
      detections,
      firewall,
      build_ms: Math.round((performance.now() - started) * 100) / 100,
      perception_note: note,
      error: null,
    };
  } catch (err) {
    // Fail closed: no payload leaves this function when redaction could not be
    // verified, and the viewer surfaces why. A Tier-1 firewall block still
    // carries its report (attached to the error as `.report`) so the panel can
    // show what was blocked, not just that something was.
    const report = err instanceof RawPiiLeakError
      ? ((err as RawPiiLeakError & { report?: FirewallReport }).report ?? null)
      : null;
    return {
      session_id: registry.session_id,
      request: null,
      detections: [],
      firewall: report,
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
      'ATHENA has no access to this tab. Click the ATHENA toolbar icon (it grants one-off access and keeps the panel open), or use Enable on this site in the panel for persistent access.',
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
    // captureVisibleTab captures whatever is visible in the window, and this
    // tab's DOM must never be used to redact another page's pixels. A run's tab
    // in the background goes DOM-only for this step.
    const [visible] = await api.tabs.query({ active: true, windowId: tab.windowId });
    if (visible?.id !== tabId) screenshotError = 'Tab is not visible; screenshot skipped.';
    else {
      screenshotDataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      // The capture call itself awaits a round trip; the user can switch tabs
      // during it. A screenshot of whatever is visible now, taken under this
      // tab's DOM, is exactly the cross-tab leak the pre-check above exists to
      // stop — re-check after the fact and discard it the same way.
      const [visibleAfter] = await api.tabs.query({ active: true, windowId: tab.windowId });
      if (visibleAfter?.id !== tabId) {
        screenshotDataUrl = null;
        screenshotError = 'Tab is not visible; screenshot skipped.';
      }
    }
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
  const preview = await buildPayload(capture, threshold, taskInstruction, tokens, priorActions);
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

const NOT_EXECUTED = 'not executed: page changed';

async function toExecutable(actions: AgentAction[], secretKey: string, registry: TokenRegistry | null): Promise<ExecutableAction[]> {
  const out: ExecutableAction[] = [];
  for (const action of actions) {
    const executable: ExecutableAction = { action: action.action as ExecutableVerb };
    if (action.selector) executable.selector = action.selector;
    if (action.option) executable.option = action.option;
    if (action.key) executable.key = action.key;
    if (action.direction) executable.direction = action.direction;
    if (action.value_ref) {
      executable.value = await resolveValueRef(action.value_ref);
      executable.value_ref = action.value_ref;
      rememberTypedSecret(secretKey, action.selector, executable.value);
    } else if (action.value_token) {
      const value = registry?.valueOf(action.value_token.slice(1, -1));
      if (value === undefined) throw new Error(`${action.value_token} is not resolvable in this run`); // opaque token text only
      executable.value = value;
      executable.value_ref = action.value_token; // display label for the audit trail, never the value
      rememberTypedSecret(secretKey, action.selector, value);
    } else if (typeof action.value === 'string') {
      // JSON round-trips absence as null, not undefined.
      executable.value = action.value;
    }
    out.push(executable);
  }
  return out;
}

async function runTabVerb(tabId: number, action: AgentAction): Promise<ActionOutcome> {
  const started = performance.now();
  try {
    if (action.action === 'navigate') await api.tabs.update(tabId, { url: action.url! });
    else await api.tabs.goBack(tabId);
    return { action: action.action, selector: null, ok: true, duration_ms: Math.round((performance.now() - started) * 100) / 100 };
  } catch (err) {
    return { action: action.action, selector: null, ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Math.round((performance.now() - started) * 100) / 100 };
  }
}

/**
 * Executes one plan against one tab. Page verbs run in the content script up
 * to the first tab verb; the tab verb runs here; the remainder is recorded as
 * not executed. Returns one outcome per planned action, in order.
 */
async function executeOnTab(tabId: number, actions: AgentAction[], allowedSelectors: string[], pageUrl: string, secretKey: string, registry: TokenRegistry | null): Promise<ActionOutcome[]> {
  const { page, tab, dropped } = splitAtTabVerb(actions);
  const outcomes: ActionOutcome[] = [];

  if (page.length > 0) {
    let executable: ExecutableAction[] | null = null;
    try {
      executable = await toExecutable(page, secretKey, registry);
    } catch (err) {
      // Nothing has run yet; a locked vault pauses the run (needs_unlock) instead of failing the step.
      if (err instanceof VaultLockedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ action: page[0]!.action, selector: page[0]!.selector ?? null, ok: false, error: message, duration_ms: 0 });
      for (const action of page.slice(1)) outcomes.push({ action: action.action, selector: action.selector ?? null, ok: false, error: NOT_EXECUTED, duration_ms: 0 });
    }
    if (executable) {
      await api.scripting.executeScript({ target: { tabId }, files: ['capture/content-script.js'] });
      const reply = (await api.tabs.sendMessage(tabId, {
        type: 'athena:execute', actions: executable, allowed_selectors: allowedSelectors, expected_origin: originOf(pageUrl),
      })) as ContentToWorker;
      if (!reply?.ok || !('outcomes' in reply)) throw new Error(reply && 'error' in reply ? reply.error : 'Executor returned nothing.');
      outcomes.push(...reply.outcomes);
    }
  }
  const pageShort = page.slice(outcomes.length); // page actions the content script never reached
  const pageFailed = outcomes.some((o) => !o.ok) || pageShort.length > 0;
  for (const action of pageShort) outcomes.push({ action: action.action, selector: action.selector ?? null, ok: false, error: NOT_EXECUTED, duration_ms: 0 });
  if (tab) outcomes.push(pageFailed ? { action: tab.action, selector: null, ok: false, error: 'not executed: earlier step failed', duration_ms: 0 } : await runTabVerb(tabId, tab));
  for (const action of dropped) outcomes.push({ action: action.action, selector: action.selector ?? null, ok: false, error: NOT_EXECUTED, duration_ms: 0 });
  return outcomes;
}

function toHistory(actions: AgentAction[], outcomes: ActionOutcome[]): PriorAction[] {
  return actions.map((action, i) => {
    const outcome = outcomes[i];
    const entry: PriorAction = { ...action, outcome: outcome ? (outcome.ok ? 'ok' : 'failed') : 'skipped' };
    if (outcome && !outcome.ok && outcome.error) entry.error = outcome.error;
    return entry;
  });
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

  const started = performance.now();
  const outcomes = await executeOnTab(tab.id, plan.response.actions, plan.request.dom_summary.map((n) => n.path), plan.page_url, tokens.session_id, tokens);
  priorActions = [...priorActions, ...toHistory(plan.response.actions, outcomes)];
  return { outcomes, execute_ms: Math.round((performance.now() - started) * 100) / 100 };
}

async function health(): Promise<HealthReport> {
  return getProviderStatus();
}

// ---------------------------------------------------------------------------
// Agent loop (Task 5). loop.ts is a pure state machine with no chrome.*
// import; loopDeps below is the only place that binds it to the worker's
// real capture/plan/execute/settle primitives. The run itself is persisted
// to chrome.storage.session so the panel can reattach after the worker is
// suspended and woken back up.
// ---------------------------------------------------------------------------

const RUN_KEY = 'athena:run';
const MAX_STEPS_KEY = 'athena:max-steps';
const stopRequested = new Set<string>();
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'stopped']);
const RUN_IN_PROGRESS_STATUSES: ReadonlySet<RunStatus> = new Set([
  'idle', 'capturing', 'planning', 'awaiting_approval', 'executing', 'settling', 'needs_permission', 'needs_unlock',
]);

/**
 * Single synchronous lock across every handler that may call drive()/approve().
 * A Set keyed by run id (the previous `driving`) left a window between the
 * check and the add — two handlers could both read "not driving" before
 * either set it, because real awaits (loadRun, permissions.contains) sit in
 * between. This flag is set and checked as the very first synchronous
 * statement in each handler, before any await, so there is no window.
 */
let driveLock = false;

/**
 * The run's token registry, held in worker memory for the common case. On a
 * worker restart mid-run (or a run id change) it is rebuilt from the
 * storage.session mirror `saveRegistry`/`loadRegistry` maintain, rather than
 * recreated from scratch — token numbering and the id→value map survive the
 * restart. Dropped from storage.session once the run reaches a terminal status.
 */
let runTokens: TokenRegistry | null = null;

/** Runs `fn` and clears any stale stop request once the run reaches a terminal status. */
async function runDrive(runId: string, fn: () => Promise<Run>): Promise<Run> {
  const result = await fn();
  if (TERMINAL_STATUSES.has(result.status)) {
    stopRequested.delete(runId);
    forgetTypedSecrets(runId);
    await dropRegistry(runId);
  }
  return result;
}

async function assertNoRunInProgress(): Promise<void> {
  const run = await loadRun();
  if (run && RUN_IN_PROGRESS_STATUSES.has(run.status)) {
    throw new Error('An agent run is in progress. Stop it first.');
  }
}

async function loadRun(): Promise<Run | null> {
  try { return ((await api.storage.session.get(RUN_KEY))?.[RUN_KEY] as Run | undefined) ?? null; } catch { return null; }
}

async function maxSteps(): Promise<number> {
  const stored = (await api.storage.local.get(MAX_STEPS_KEY))?.[MAX_STEPS_KEY];
  return typeof stored === 'number' && stored >= 1 && stored <= 200 ? stored : 25;
}

async function waitForTabComplete(tabId: number): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + 10_000;
  let tab = await api.tabs.get(tabId);
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    tab = await api.tabs.get(tabId);
  }
  return tab;
}

const loopDeps = {
  capture: (tabId: number) => runCapture(tabId),
  plan: async (capture: CaptureResult, goal: string, history: PriorAction[], runId: string) => {
    // The loop owns its own registry and history — never the module-level
    // `tokens`/`priorActions` (those belong to the single-step flows only) and
    // never LAST_PLAN_KEY (a run's pending plan is not the single-step
    // "last plan"; execute-plan must not be able to run it without approval).
    if (!runTokens || runTokens.session_id !== runId) runTokens = (await loadRegistry(runId)) ?? new TokenRegistry(runId);
    const preview = await buildPayload(capture, DEFAULT_THRESHOLD, goal, runTokens, history);
    if (!preview.request) throw new Error(preview.error ?? 'No payload was built.');
    const response = await requestPlan(preview.request);
    return { preview, response };
  },
  execute: async (tabId: number, actions: AgentAction[], allowed: string[], pageUrl: string, runId: string) => {
    const tab = await api.tabs.get(tabId);
    if (!tab.url || originOf(tab.url) !== originOf(pageUrl)) throw new Error('The page changed since it was captured.');
    return toHistory(actions, await executeOnTab(tabId, actions, allowed, pageUrl, runId, runTokens));
  },
  settle: async (tabId: number) => {
    // A click-driven navigation may not have flipped the tab to 'loading' yet.
    await new Promise((r) => setTimeout(r, 150));
    const tab = await waitForTabComplete(tabId);
    const url = tab.url;
    const origin = url ? originOf(url) : undefined;
    // Unusable: no URL, a browser-internal page, or an opaque ("null") origin.
    // None of these can ever be granted host permission, so report no url —
    // the loop's originOf(undefined) is undefined, and the existing
    // `!run.needs_origin` branch in run-grant-and-resume stops the run instead
    // of leaving it stuck in needs_permission forever.
    if (!url || isRestrictedUrl(url) || !origin || origin === 'null') return { url: undefined, granted: false };
    // Injection is the probe either way: without a host grant activeTab may still
    // cover this tab (same tab, earlier gesture); with one, an error page or a
    // tab that closed mid-navigation fails the same way. A failure is not granted.
    try { await api.scripting.executeScript({ target: { tabId }, files: ['capture/content-script.js'] }); }
    catch { return { url, granted: false }; }
    try { await api.tabs.sendMessage(tabId, { type: 'athena:settle' }); } catch { /* page navigated again */ }
    // The quiet period can end in a navigation; let that load finish before capturing.
    await waitForTabComplete(tabId);
    return { url, granted: true };
  },
  save: async (run: Run) => {
    // A drive still in flight after Stop must not overwrite the stopped record.
    if (stopRequested.has(run.run_id) && run.status !== 'stopped') return;
    try { await api.storage.session.set({ [RUN_KEY]: run }); } catch { /* memory copy in flight */ }
    api.runtime.sendMessage({ type: 'athena:run-changed', run }).catch(() => { /* panel closed */ });
  },
  stopped: (runId: string) => stopRequested.has(runId),
};

api.runtime.onMessage.addListener(
  (message: PanelToWorker, sender, sendResponse: (r: WorkerReply<never>) => void) => {
    const fail = (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });

    const ok = (data: unknown) => sendResponse({ ok: true, data } as WorkerReply<never>);

    // Content scripts run in page renderers; vault messages come only from our own
    // extension pages (panel, options — the options page may sit in a tab, so no !sender.tab test).
    if (typeof message?.type === 'string' && message.type.startsWith('athena:vault-')
      && !(sender.id === api.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL('')))) {
      fail(new Error('Refused: vault messages are accepted from extension pages only.'));
      return true;
    }

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
          return buildPayload(capture, message.threshold, message.task_instruction, tokens, priorActions);
        })
        .then(ok)
        .catch(fail);
      return true;
    }
    if (message?.type === 'athena:reset-session') {
      assertNoRunInProgress().then(() => ({ session_id: resetSession() })).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:request-plan') {
      assertNoRunInProgress()
        .then(() => requestPlanFlow(message.threshold, message.task_instruction))
        .then(ok)
        .catch(fail);
      return true;
    }
    if (message?.type === 'athena:execute-plan') {
      assertNoRunInProgress().then(() => executePlanFlow(message.tab_id)).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:check-health') {
      health().then(ok).catch(fail);
      return true;
    }
    // Vault: values only travel panel → worker; every reply is a VaultStatus (slot names, flags).
    if (message?.type === 'athena:vault-status') { vaultStatus().then(ok).catch(fail); return true; }
    // Only VaultError messages (wrong passphrase, mismatch, no vault) reach the panel verbatim.
    const failVault = (fallback: string) => (err: unknown) => fail(err instanceof VaultError ? err : new Error(fallback));
    if (message?.type === 'athena:vault-create') {
      createVault(message.passphrase ?? '', message.confirm ?? '').then(ok).catch(failVault('Could not create the vault.'));
      return true;
    }
    if (message?.type === 'athena:vault-unlock') {
      (message.passphrase ? unlockVault(message.passphrase) : Promise.reject(new VaultError('Enter a passphrase.')))
        .then(ok).catch(failVault('Could not unlock the vault.'));
      return true;
    }
    if (message?.type === 'athena:vault-lock') { lockVault().then(vaultStatus).then(ok).catch(fail); return true; }
    if (message?.type === 'athena:vault-set') { setSlot(message.slot, message.value).then(ok).catch(fail); return true; }
    if (message?.type === 'athena:vault-delete') { deleteSlot(message.slot).then(ok).catch(fail); return true; }
    if (message?.type === 'athena:vault-set-api-key') { setProviderApiKey(message.value?.trim() || null).then(ok).catch(fail); return true; }
    if (message?.type === 'athena:run-start') {
      if (driveLock) { fail(new Error('The agent is busy. Wait for the current step or stop the run.')); return true; }
      driveLock = true;
      (async () => {
        const existing = await loadRun();
        if (existing && !TERMINAL_STATUSES.has(existing.status)) {
          // The lock (checked above) rules out a concurrent drive, so this is a
          // run left dangling by a worker restart or a closed panel — retire it
          // before starting fresh, and mark it stopped so a drive that was
          // actually still in flight for it does not keep going unnoticed.
          stopRequested.add(existing.run_id);
          await loopDeps.save(stop(existing));
          stopRequested.delete(existing.run_id);
          forgetTypedSecrets(existing.run_id);
        }
        const tab = await targetTab(message.tab_id);
        if (!tab?.id) throw new Error('No active tab.');
        const run = newRun(message.goal, tab.id, message.mode, await maxSteps());
        await loopDeps.save(run);
        return runDrive(run.run_id, () => drive(run, loopDeps));
      })().then(ok).catch(fail).finally(() => { driveLock = false; });
      return true;
    }
    if (message?.type === 'athena:run-approve') {
      // The panel sends the step number of the run it displayed when approval
      // was requested; a stale click on a superseded step is refused rather
      // than silently applied to whatever step the run is on now.
      if (driveLock) { fail(new Error('The agent is busy. Wait for the current step or stop the run.')); return true; }
      driveLock = true;
      loadRun().then((run) => {
        if (!run) throw new Error('No run in progress.');
        if (run.step !== message.step || (run.status !== 'awaiting_approval' && run.status !== 'needs_unlock')) {
          throw new Error('That step is no longer awaiting approval.');
        }
        return runDrive(run.run_id, () => approve(run, loopDeps));
      }).then(ok).catch(fail).finally(() => { driveLock = false; });
      return true;
    }
    if (message?.type === 'athena:run-stop') {
      loadRun().then(async (run) => {
        if (!run) throw new Error('No run in progress.');
        stopRequested.add(run.run_id);
        const stopped = stop(run);
        await loopDeps.save(stopped);
        // No drive may be in flight for this run (it may have been sitting at
        // awaiting_approval/needs_permission/idle) — runDrive's own cleanup
        // never runs in that case, so it happens here instead.
        stopRequested.delete(run.run_id);
        forgetTypedSecrets(run.run_id);
        return stopped;
      }).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:run-get') {
      loadRun().then(async (run) => {
        // Mid-step with no drive in flight: the worker restarted under it.
        if (run && !driveLock && ['idle', 'capturing', 'planning', 'executing', 'settling'].includes(run.status)) {
          const failed: Run = { ...run, status: 'failed', pending: null, error: 'interrupted by a browser restart; start again' };
          await loopDeps.save(failed);
          return failed;
        }
        return run;
      }).then(ok).catch(fail);
      return true;
    }
    if (message?.type === 'athena:run-grant-and-resume') {
      if (driveLock) { fail(new Error('The agent is busy. Wait for the current step or stop the run.')); return true; }
      driveLock = true;
      loadRun().then(async (run) => {
        if (!run || run.status !== 'needs_permission') throw new Error('Nothing is waiting for permission.');
        if (!run.needs_origin) {
          // No origin to request — this run can never be resumed. Stop it
          // cleanly instead of throwing so the panel can show a Stopped state
          // with a clear reason.
          const stopped = { ...stop(run), error: 'needs access to a page it cannot inject into' };
          await loopDeps.save(stopped);
          return stopped;
        }
        // Panel-first: the panel calls api.permissions.request itself (needs a
        // user gesture) before sending this message; the worker only checks
        // whether the grant landed.
        const granted = await api.permissions.contains({ origins: [`${run.needs_origin}/*`] });
        if (!granted) return run;
        const { needs_origin: _drop, ...rest } = run;
        return runDrive(run.run_id, () => drive({ ...rest, status: 'capturing' }, loopDeps));
      }).then(ok).catch(fail).finally(() => { driveLock = false; });
      return true;
    }
    return false;
  },
);

/**
 * The toolbar icon opens the panel and grants activeTab for the page — every
 * time, never toggling the panel closed. Chrome's built-in
 * `openPanelOnActionClick` toggles, which turns "click the icon to grant
 * access" into "click the icon and watch the panel disappear". Handling the
 * click ourselves keeps the gesture (sidePanel.open requires one) and keeps
 * the panel up. The keyboard shortcut (`_execute_action`) lands here too.
 */
if (api.sidePanel) {
  api.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((err) => console.warn('[athena] could not configure the side panel:', err));
  api.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    api.sidePanel.open({ tabId: tab.id }).catch((err) => console.warn('[athena] could not open the side panel:', err));
  });
} else {
  console.warn('[athena] chrome.sidePanel is unavailable; open the panel from the side-panel picker.');
}
