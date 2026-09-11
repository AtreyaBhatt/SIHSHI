/**
 * ATHENA side panel controller.
 *
 * This is the extension's user surface: it reads the page the user is on, shows
 * what local perception found, shows the exact sanitized body that would cross
 * the network boundary, and gates execution of the server's plan behind an
 * explicit review.
 *
 * It replaced a toolbar popup. The reason is in the demo script: the last step is
 * "approve, then watch the real page complete the task". A popup is destroyed the
 * moment it loses focus, so it vanishes at the step it exists to show. The panel
 * stays beside the portal.
 *
 * Everything rendered here comes from the worker — capture, detections, the
 * redaction manifest, the plan, the execution outcomes. The panel holds no
 * fabricated state, and a value_ref is always shown as the slot name: resolving
 * it happens in the executor, which is the only place a secret may exist.
 *
 * Two lifecycle facts a popup could ignore and this cannot: the panel outlives
 * tab switches and worker suspensions, so page context is re-derived from
 * `chrome.tabs` events and every render is rebuilt from worker state rather than
 * from module memory that may already be gone.
 *
 * Status reporting follows the design: there is no global status bar, so a
 * message goes where it belongs — capture failures to the perception card's note,
 * payload refusals to the preview note, plan and execution state to the plan
 * badge and steps — and the activity log keeps the record either way.
 */
import { api, isRestrictedUrl } from '../shared/browser';
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from '../background/agent-client';
import { readVault, writeVault, type Vault } from '../shared/vault';
import type { CaptureResult, RedactionManifestEntry } from '../shared/schema';
import type {
  ExecutionResult, PanelToWorker, PayloadPreview, PlanPreview, ResponseFor, WorkerReply,
} from '../shared/messages';
import type { Detection } from '../pii-detection/types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const taskEl = $<HTMLTextAreaElement>('task');
const thresholdInput = $<HTMLInputElement>('threshold');
const thresholdValue = $('thr-value');
const showBoxes = $<HTMLInputElement>('show-boxes');
const askButton = $<HTMLButtonElement>('ask');
const analyzeButton = $<HTMLButtonElement>('analyze');
const pillEl = $('privacy-pill');
const pillText = $('pill-text');
const pageFav = $('page-fav');
const pageStatus = $('page-status');
const pageState = $('page-state');
const perceptionNote = $('perception-note');
const previewNote = $('preview-note');
const planBadge = $('plan-badge');
const planSteps = $('plan-steps');
const planActions = $('plan-actions');
const activityList = $('activity-list');
const activityCount = $('activity-count');
const activityToggle = $<HTMLButtonElement>('activity-toggle');
const outbound = $('outbound');
const previewLink = $<HTMLButtonElement>('preview-link');
const approval = $('approval');
const toastEl = $('toast');
const toastMessage = $('toast-message');

let capture: CaptureResult | null = null;
let preview: PayloadPreview | null = null;
let plan: PlanPreview | null = null;
let execution: ExecutionResult | null = null;

/** Which tab the current capture describes. A mismatch means the panel is stale. */
let inspectedTabId: number | null = null;
let currentTabId: number | null = null;
let currentPageLabel = 'the page under inspection';
/** The page the capture (and therefore the plan) describes — not whatever tab is active at approval time. */
let inspectedPageLabel = currentPageLabel;
/** Origin pattern for chrome.permissions; null when the tab has no readable http(s) URL. */
let currentOriginPattern: string | null = null;
/** Whether currentOriginPattern is granted, as of the last render. The click handler reads this instead of awaiting `contains`, so `request` runs first and keeps the user gesture. */
let currentOriginGranted = false;
/** Monotonic render token: a slow `contains` from an earlier tab must not paint over a later render. */
let siteAccessRender = 0;

interface Activity { at: number; text: string; tone: 'ok' | 'info' | 'warn' }
const activity: Activity[] = [];
let toastTimer: number | undefined;
let rebuildTimer: number | undefined;

// --- plumbing ---------------------------------------------------------------

async function send<M extends PanelToWorker>(message: M): Promise<ResponseFor<M>> {
  const reply = (await api.runtime.sendMessage(message)) as WorkerReply<ResponseFor<M>> | undefined;
  if (!reply) throw new Error('The extension worker did not respond — try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function showToast(message: string, isError = false): void {
  toastMessage.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), 3600);
}

/**
 * Append-only for the session. These are real events from the pipeline, not
 * artboard copy: if it did not happen, it is not logged.
 */
function note(text: string, tone: Activity['tone'] = 'info'): void {
  activity.push({ at: Date.now(), text, tone });
  if (activity.length > 60) activity.shift();
  renderActivity();
}

const TONE_COLOR: Record<Activity['tone'], string> = { ok: '#1fa971', info: '#9aa5a1', warn: '#e0a33a' };

/** Elapsed time since the newest event, in the design's short form. */
function elapsedLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 2) return 'now';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function renderActivity(): void {
  activityCount.textContent = String(activity.length);
  const collapsed = activityToggle.getAttribute('aria-expanded') === 'false';
  activityList.hidden = collapsed || activity.length === 0;
  if (activityList.hidden) return;
  activityList.innerHTML = activity
    .map((e) => `<div class="ev"><span class="d" style="background:${TONE_COLOR[e.tone]}"></span><span>${esc(e.text)}</span><span class="tm">${elapsedLabel(e.at)}</span></div>`)
    .join('');
}

function updatePill(stale = false): void {
  pillEl.classList.toggle('stale', stale);
  pillText.textContent = stale ? 'Panel is stale' : 'Privacy active';
}

async function renderSiteAccess(url: string | undefined): Promise<void> {
  const render = ++siteAccessRender;
  const button = $<HTMLButtonElement>('site-access');
  const noteEl = $('site-access-note');
  const hide = (): void => {
    currentOriginPattern = null;
    currentOriginGranted = false;
    button.hidden = true;
    noteEl.textContent = '';
  };
  if (!url || isRestrictedUrl(url)) return hide();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return hide();
  }
  if (!/^https?:$/.test(parsed.protocol)) return hide();

  const pattern = `${parsed.origin}/*`;
  let granted = false;
  try {
    granted = await api.permissions.contains({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (render !== siteAccessRender) return; // a newer render owns the button now

  currentOriginPattern = pattern;
  currentOriginGranted = granted;
  button.hidden = false;
  button.textContent = granted ? 'Disable on this site' : 'Enable on this site';
  noteEl.textContent = granted
    ? `Enabled on ${parsed.host} — captures work here without clicking the icon.`
    : 'One-off access only. Enable to keep working here across navigations.';
}

/** Narrow, non-screenshot status for the card the message belongs to. */
function setPerceptionNote(text: string, warn = false): void {
  perceptionNote.textContent = text;
  perceptionNote.style.color = warn ? '#8a5a10' : '';
}

function setPreviewNote(text: string, warn = false): void {
  previewNote.textContent = text;
  previewNote.style.color = warn ? '#a8321c' : '';
}

// --- screenshots ------------------------------------------------------------

interface Box { bbox: [number, number, number, number]; className: string; title: string }

/**
 * Boxes are viewport CSS pixels; the image renders at whatever width the panel
 * gives it, so scale by the rendered width rather than by devicePixelRatio.
 */
function paintShot(container: HTMLElement, imageSrc: string | null, boxes: Box[], emptyMessage: string): void {
  if (!imageSrc) {
    container.classList.remove('has-image');
    container.innerHTML = `<p class="empty">${esc(emptyMessage)}</p>`;
    return;
  }
  container.classList.add('has-image');
  container.innerHTML = '';

  const img = document.createElement('img');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const draw = (): void => {
    overlay.innerHTML = '';
    if (!capture) return;
    const scale = img.clientWidth / capture.snapshot.viewport.width;
    for (const box of boxes) {
      const [x1, y1, x2, y2] = box.bbox;
      const el = document.createElement('div');
      el.className = box.className;
      el.style.left = `${x1 * scale}px`;
      el.style.top = `${y1 * scale}px`;
      el.style.width = `${(x2 - x1) * scale}px`;
      el.style.height = `${(y2 - y1) * scale}px`;
      el.title = box.title;
      overlay.appendChild(el);
    }
  };

  img.addEventListener('load', draw);
  img.src = imageSrc;
  container.append(img, overlay);
}

// --- page context -----------------------------------------------------------

/**
 * `activeTab` is granted per tab when the user invokes the extension, so the tab
 * the panel was opened on is readable while others are not. That is a real
 * limitation of the permission, not a bug to paper over: the panel says it needs
 * to be invoked on this page rather than showing a stale title as if it were current.
 */
async function refreshPageContext(): Promise<void> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await api.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = undefined;
  }

  currentTabId = tab?.id ?? null;
  const stale = inspectedTabId !== null && currentTabId !== inspectedTabId;
  updatePill(stale);

  const show = (title: string, domain: string, state: string, warn: boolean): void => {
    $('page-title').textContent = title;
    $('page-domain').textContent = domain;
    pageState.textContent = state;
    pageStatus.classList.toggle('warn', warn);
    pageFav.classList.toggle('none', warn);
    pageFav.textContent = warn ? '·' : (domain.replace(/^www\./, '')[0] ?? '·').toUpperCase();
  };

  if (!tab) {
    show('No active tab', '—', 'Nothing to inspect.', true);
    void renderSiteAccess(undefined);
    return;
  }
  if (tab.url === undefined) {
    show(tab.title ?? 'Untitled tab', 'Access not granted for this tab', 'Click the ATHENA toolbar icon to grant access to this page — the panel stays open.', true);
    // activeTab arrives when the user clicks the toolbar icon, and no event fires
    // when it does — so keep re-checking until the page becomes readable.
    window.clearTimeout(pageTimer);
    pageTimer = window.setTimeout(() => void refreshPageContext(), 1000);
    void renderSiteAccess(undefined);
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    show(tab.title ?? 'Restricted page', 'Browser-internal page', 'This page cannot be inspected.', true);
    void renderSiteAccess(undefined);
    return;
  }

  let host = tab.url;
  try {
    host = new URL(tab.url).host;
  } catch {
    /* keep the raw string */
  }
  currentPageLabel = `${tab.title ?? host} on ${host}`;
  show(
    tab.title ?? host,
    host,
    stale ? 'Switched page — capture again for this tab.' : capture ? 'Captured from this tab.' : 'Ready for local screen analysis',
    stale,
  );
  void renderSiteAccess(tab.url);
}

// --- renderers --------------------------------------------------------------

function renderPrivacy(): void {
  const detections = preview?.detections ?? [];
  const secrets = detections.filter((d) => d.tier === 1 && d.type !== 'face' && d.type !== 'frame').length;
  const masked = detections.filter((d) => d.tier === 2).length;
  const faces = detections.filter((d) => d.type === 'face').length;

  const paint = (chipId: string, textId: string, count: number, noun: string, verb: string): void => {
    const chip = $(chipId);
    chip.classList.toggle('muted', count === 0);
    $(textId).textContent = count === 0
      ? `No ${noun}s detected`
      : `${count} ${noun}${count === 1 ? '' : 's'} ${verb}`;
  };
  paint('chip-secrets', 'chip-secrets-text', secrets, 'secret', 'hard-blocked');
  paint('chip-masked', 'chip-masked-text', masked, 'identifier', 'masked');
  paint('chip-faces', 'chip-faces-text', faces, 'face', 'blurred');

  const sub = $('privacy-sub');
  if (!preview) sub.textContent = 'Sensitive data stays on this device.';
  else if (detections.length === 0) sub.textContent = 'Nothing sensitive found above the confidence threshold.';
  else sub.textContent = `${detections.length} sensitive region(s) held back from the request.`;
}

function renderDetections(): void {
  const detections = preview?.detections ?? [];
  const list = $('detections');

  const boxes: Box[] = showBoxes.checked && capture
    ? capture.snapshot.nodes.map((n) => ({
        bbox: n.bbox,
        className: n.interactive ? 'b interactive' : 'b',
        title: `${n.path}${n.label ? ` — ${n.label}` : ''}`,
      }))
    : detections.map((d) => ({
        bbox: d.bbox ?? [0, 0, 0, 0],
        className: `b ${d.type === 'face' ? 'face' : `t${d.tier}`}`,
        title: `${d.type} (tier ${d.tier}) · ${d.detector} · ${d.confidence}`,
      }));

  paintShot(
    $('det-shot'),
    capture?.screenshot_data_url ?? null,
    boxes,
    capture
      ? `No screenshot — ${capture.screenshot_error ?? 'unavailable'}. The DOM snapshot is still usable.`
      : 'No capture yet. Ask ATHENA to look at this page.',
  );

  if (detections.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = detections
    .map((d: Detection) => `
      <div class="det tier${d.tier}">
        <div class="hd">
          <span class="ty">${esc(d.type)}</span>
          <span class="who">tier ${d.tier} · ${esc(d.detector)} · ${d.confidence}</span>
        </div>
        <div class="path">${esc(d.node_path)} <span class="who">[${esc(d.field)}${d.span ? ` ${d.span[0]}–${d.span[1]}` : ''}]</span></div>
      </div>`)
    .join('');
}

function renderManifest(entries: RedactionManifestEntry[]): string {
  const rows = entries
    .map((e) => `
      <tr>
        <td>${esc(e.id)}</td>
        <td class="tier${e.tier}">${e.tier}</td>
        <td>${esc(e.type)}</td>
        <td>${esc(e.masking)}</td>
        <td>${esc(e.dom_path ?? '—')}</td>
        <td>${e.bbox ? e.bbox.join(', ') : '—'}</td>
      </tr>`)
    .join('');
  return `<table class="man">
      <thead><tr><th>id</th><th>tier</th><th>type</th><th>masking</th><th>dom_path</th><th>bbox</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderOutbound(): void {
  const manCount = $('man-count');

  if (!preview) {
    paintShot($('redacted-shot'), null, [], 'Nothing captured yet.');
    setPreviewNote('Personal data redacted. Only safe, useful content is shared with our AI.');
    $('outbound-status').innerHTML = '';
    $('manifest').innerHTML = '';
    $('payload').textContent = '—';
    manCount.textContent = '0';
    return;
  }

  if (preview.error || !preview.request) {
    paintShot($('redacted-shot'), null, [], 'No payload was built.');
    setPreviewNote('Payload refused — nothing was sent.', true);
    $('outbound-status').innerHTML = `<div class="banner blocked"><strong>Refused to build a payload.</strong> ${esc(preview.error ?? 'unknown')}</div>`;
    $('manifest').innerHTML = '';
    $('payload').textContent = '—';
    manCount.textContent = '0';
    return;
  }

  const request = preview.request;
  paintShot(
    $('redacted-shot'),
    request.screenshot_redacted ? `data:image/png;base64,${request.screenshot_redacted}` : null,
    [],
    'No screenshot was captured, so there is none to redact.',
  );

  const entries = request.redaction_manifest.length;
  setPreviewNote(`Personal data redacted · ${entries} manifest entr${entries === 1 ? 'y' : 'ies'}. Only safe, useful content is shared with our AI.`);
  $('outbound-status').innerHTML = `<div class="banner ok"><strong>Payload built in ${preview.build_ms} ms.</strong> Displayed only — nothing is sent until you ask for a plan.</div>`;

  manCount.textContent = String(entries);
  $('manifest').innerHTML = entries
    ? renderManifest(request.redaction_manifest)
    : '<p class="empty">Nothing was redacted on this screen.</p>';

  // The screenshot is megabytes of base64 and would drown the pane; the image
  // above already shows it.
  $('payload').textContent = JSON.stringify(
    { ...request, screenshot_redacted: request.screenshot_redacted ? `<base64 PNG, ${request.screenshot_redacted.length} chars>` : null },
    null,
    2,
  );
}

const ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m5.4 8.2 1.8 1.8 3.6-3.8"/></svg>';
const ICON_RING = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>';

function renderPlan(): void {
  if (!plan) {
    planBadge.textContent = 'Idle';
    planBadge.className = 'tag';
    planSteps.innerHTML = '<p class="empty" style="margin-top:10px;">No plan yet. Ask ATHENA to capture and plan.</p>';
    planActions.hidden = true;
    return;
  }
  if (plan.error || !plan.response) {
    planBadge.textContent = 'No plan';
    planBadge.className = 'tag bad';
    planSteps.innerHTML = `<div class="banner blocked"><strong>No plan.</strong> ${esc(plan.error ?? 'unknown')}</div>`;
    planActions.hidden = true;
    return;
  }

  const response = plan.response;
  const outcomes = execution?.outcomes ?? [];
  const failed = outcomes.filter((o) => !o.ok).length;

  planBadge.textContent = execution ? (failed ? `${failed} failed` : 'Executed') : 'Awaiting approval';
  planBadge.className = execution ? `tag ${failed ? 'bad' : 'ok'}` : 'tag';

  const steps = response.actions
    .map((action, index) => {
      const outcome = outcomes[index];
      const state = outcome ? (outcome.ok ? 'done' : 'failed') : execution ? '' : 'next';
      const icon = outcome ? (outcome.ok ? ICON_CHECK : ICON_RING) : ICON_RING;
      // A value_ref is shown as the slot name, never resolved here: the panel is
      // a page like any other and the resolved secret belongs only in the executor.
      const detail = action.value_ref
        ? `<span class="sub">Resolves <code>${esc(action.value_ref)}</code> on this device, never sent</span>`
        : typeof action.value === 'string'
          ? `<span class="sub">Types <code>${esc(action.value)}</code></span>`
          : '';
      const result = outcome ? `<span class="sub">${outcome.ok ? `ok in ${outcome.duration_ms} ms` : esc(outcome.error ?? 'failed')}</span>` : '';
      return `<div class="step ${state}">
          <span class="n">${index + 1}</span>${icon}
          <span>${esc(action.action)} <code>${esc(action.selector ?? '—')}</code>${detail}${result}</span>
        </div>`;
    })
    .join('');

  const rejections = response.guardrail_rejections?.length
    ? `<div class="banner blocked"><strong>Server guardrails dropped ${response.guardrail_rejections.length} action(s):</strong> ${response.guardrail_rejections.map(esc).join('<br />')}</div>`
    : '';

  planSteps.innerHTML = `
    <p class="t2" style="margin:10px 0 4px;">${esc(response.reasoning_summary)}</p>
    ${rejections}
    ${steps || '<p class="empty">The planner returned no actions.</p>'}`;

  planActions.hidden = response.actions.length === 0;
  $<HTMLButtonElement>('approve').disabled = Boolean(execution);
}

function renderAll(): void {
  renderPrivacy();
  renderDetections();
  renderOutbound();
  renderPlan();
}

// --- flow -------------------------------------------------------------------

function currentTaskInstruction(): string {
  return taskEl.value.trim() || 'Describe this screen and identify the next action.';
}

/** Capture → detect → redact. No network: this is the "analyze safely" path. */
async function captureAndRedact(): Promise<void> {
  setPerceptionNote('Capturing…');
  capture = await send({ type: 'athena:run-capture' });
  inspectedTabId = currentTabId;
  inspectedPageLabel = currentPageLabel;
  note(`Captured ${capture.snapshot.nodes.length} nodes from ${capture.snapshot.viewport.width}×${capture.snapshot.viewport.height}`, 'ok');

  preview = await send({
    type: 'athena:build-payload',
    threshold: Number(thresholdInput.value),
    task_instruction: currentTaskInstruction(),
  });
  $('session-id').textContent = preview.session_id.slice(0, 8);
  execution = null;
  renderAll();

  const redacted = preview.request?.redaction_manifest.length ?? 0;
  setPerceptionNote(preview.perception_note ?? `${preview.detections.length} detected`);
  note(`${preview.detections.length} detections, ${redacted} redaction(s), payload built in ${preview.build_ms} ms`, 'ok');
  if (preview.perception_note) note(preview.perception_note, 'info');
}

/** Re-derives the payload from the capture already held. Used by the threshold slider. */
async function rebuild(): Promise<void> {
  if (!capture) return;
  preview = await send({
    type: 'athena:build-payload',
    threshold: Number(thresholdInput.value),
    task_instruction: currentTaskInstruction(),
  });
  $('session-id').textContent = preview.session_id.slice(0, 8);
  renderAll();
}

// --- approval ---------------------------------------------------------------

/**
 * The deck's rule — "sensitive or destructive actions require user confirmation" —
 * is implemented here rather than as a property of the action: the panel cannot
 * see the page, so it cannot tell a Submit from a Next. Reviewing every plan is
 * the only honest option, and it is cheap.
 */
function openApproval(): void {
  if (!plan?.response) return;
  const response = plan.response;
  const rows: Array<[string, string, boolean]> = [
    ['Actions', String(response.actions.length), false],
    ['Target', inspectedPageLabel, false],
    ['Local credential', response.requires_client_secret ? 'resolved on this device' : 'not required', response.requires_client_secret],
  ];
  $('approval-body').innerHTML = `ATHENA will run <strong>${response.actions.length} action${response.actions.length === 1 ? '' : 's'}</strong> on ${esc(inspectedPageLabel)}.${
    response.requires_client_secret ? ' Your stored credential is filled in locally and never sent to the server.' : ''
  }`;
  $('approval-summary').innerHTML = rows
    .map(([k, v, warn]) => `<div><span>${k}</span><b${warn ? ' class="warn"' : ''}>${esc(v)}</b></div>`)
    .join('');
  approval.hidden = false;
  $('approval-confirm').focus();
  note('Execution held for approval', 'warn');
}

async function confirmExecution(): Promise<void> {
  approval.hidden = true;
  note('Approved — executing on the live page', 'ok');
  try {
    execution = await send({ type: 'athena:execute-plan' });
    const failed = execution.outcomes.filter((o) => !o.ok).length;
    note(failed ? `${failed} action(s) failed during execution` : `Executed ${execution.outcomes.length} action(s) in ${execution.execute_ms} ms`, failed ? 'warn' : 'ok');
    showToast(failed ? `${failed} action(s) failed.` : `Executed in ${execution.execute_ms} ms.`, failed > 0);
    renderPlan();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(`Execution failed: ${message}`, 'warn');
    showToast(message, true);
  }
}

// --- events -----------------------------------------------------------------

askButton.addEventListener('click', async () => {
  askButton.disabled = true;
  analyzeButton.disabled = true;
  try {
    // Always a fresh capture. Planning from a snapshot of a tab the user has
    // since left would send another page's selectors to be executed on this one.
    capture = await send({ type: 'athena:run-capture' });
    inspectedTabId = currentTabId;
    inspectedPageLabel = currentPageLabel;
    note(`Captured ${capture.snapshot.nodes.length} nodes`, 'ok');
    execution = null;
    plan = await send({
      type: 'athena:request-plan',
      threshold: Number(thresholdInput.value),
      task_instruction: currentTaskInstruction(),
    });
    preview = plan.preview;
    $('session-id').textContent = preview.session_id.slice(0, 8);
    renderAll();
    setPerceptionNote(preview.perception_note ?? `${preview.detections.length} detected`);
    note(`Sanitized context sent · plan received in ${plan.network_ms} ms`, plan.error ? 'warn' : 'info');
    if (plan.error) {
      showToast(plan.error, true);
    } else {
      showToast('Plan ready. Nothing sensitive left this device.');
      note('Action blocked pending approval', 'warn');
    }
    void refreshPageContext();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setPerceptionNote(message, true);
    note(`Planning failed: ${message}`, 'warn');
    showToast(message, true);
  } finally {
    askButton.disabled = false;
    analyzeButton.disabled = false;
  }
});

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  askButton.disabled = true;
  try {
    await captureAndRedact();
    showToast('Analysis complete. Nothing sensitive left this device.');
    void refreshPageContext();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setPerceptionNote(message, true);
    note(`Capture failed: ${message}`, 'warn');
    showToast(message, true);
  } finally {
    analyzeButton.disabled = false;
    askButton.disabled = false;
  }
});

taskEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    askButton.click();
  }
});

thresholdInput.addEventListener('input', () => {
  thresholdValue.textContent = Number(thresholdInput.value).toFixed(2);
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    rebuild()
      .then(() => note(`Threshold ${Number(thresholdInput.value).toFixed(2)} · payload rebuilt`, 'info'))
      .catch((err) => setPerceptionNote(String(err), true));
  }, 120);
});

showBoxes.addEventListener('change', renderDetections);

$('site-access').addEventListener('click', async () => {
  const pattern = currentOriginPattern;
  if (!pattern) return;
  try {
    if (currentOriginGranted) {
      await api.permissions.remove({ origins: [pattern] });
      note(`Disabled on ${pattern}`, 'info');
    } else {
      // First call in the handler on purpose: chrome.permissions.request needs the
      // click's user gesture, and an await before it can spend that activation.
      const ok = await api.permissions.request({ origins: [pattern] });
      note(ok ? `Enabled on ${pattern}` : 'Permission request declined', ok ? 'ok' : 'warn');
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
  await refreshPageContext();
});

previewLink.addEventListener('click', () => {
  const open = outbound.hidden;
  outbound.hidden = !open;
  previewLink.setAttribute('aria-expanded', String(open));
});

activityToggle.addEventListener('click', () => {
  const collapsed = activityToggle.getAttribute('aria-expanded') === 'false';
  activityToggle.setAttribute('aria-expanded', String(collapsed));
  renderActivity();
});

$('open-viewer').addEventListener('click', async () => {
  // The viewer needs the tab it should inspect: once it is focused, it *is* the
  // active tab, and asking the worker for "the active tab" would capture it.
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  await api.tabs.create({ url: api.runtime.getURL(`viewer/viewer.html?tab=${tab?.id ?? ''}`) });
});

$('reset-session').addEventListener('click', async () => {
  const { session_id } = await send({ type: 'athena:reset-session' });
  $('session-id').textContent = session_id.slice(0, 8);
  plan = null;
  execution = null;
  note('Session reset — token mapping discarded', 'info');
  await rebuild();
  renderAll();
  showToast('New session — token mapping discarded.');
});

$('approve').addEventListener('click', openApproval);
$('cancel-plan').addEventListener('click', () => {
  note('Cancelled before approval — nothing was executed', 'info');
  planActions.hidden = true;
  showToast('Nothing executed.');
});
$('approval-confirm').addEventListener('click', () => void confirmExecution());
$('approval-cancel').addEventListener('click', () => {
  approval.hidden = true;
  note('Approval declined — nothing was executed', 'warn');
  showToast('Nothing executed.');
});
approval.addEventListener('click', (event) => {
  if (event.target === approval) approval.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !approval.hidden) approval.hidden = true;
});

// --- tabs -------------------------------------------------------------------

const tabs: Array<[HTMLButtonElement, HTMLElement]> = [
  [$<HTMLButtonElement>('tab-assistant'), $('view-assistant')],
  [$<HTMLButtonElement>('tab-settings'), $('view-settings')],
];

for (const [button, view] of tabs) {
  button.addEventListener('click', () => {
    for (const [other, otherView] of tabs) {
      const active = other === button;
      other.classList.toggle('on', active);
      other.setAttribute('aria-selected', String(active));
      otherView.hidden = !active;
    }
    // Images have no layout width while their view is hidden, so overlays must be
    // re-laid-out when one becomes visible.
    if (view.id === 'view-assistant') renderAll();
  });
}

// --- settings ---------------------------------------------------------------

function renderSlots(vault: Vault): void {
  const slots = Object.keys(vault).sort();
  $('slots').innerHTML = slots.length
    ? `<table class="man"><thead><tr><th>value_ref</th><th>stored</th><th></th></tr></thead><tbody>${slots
        .map((slot) => `<tr>
            <td>user_saved:${esc(slot)}</td>
            <td>${'•'.repeat(Math.min(vault[slot]!.length, 12))} (${vault[slot]!.length})</td>
            <td><button class="link" data-remove="${esc(slot)}">remove</button></td>
          </tr>`)
        .join('')}</tbody></table>`
    : '<p class="empty">No credentials stored. The executor will refuse any value_ref it cannot resolve.</p>';

  for (const button of $('slots').querySelectorAll<HTMLButtonElement>('[data-remove]')) {
    button.addEventListener('click', async () => {
      const next: Vault = { ...(await readVault()) };
      delete next[button.dataset.remove!];
      await writeVault(next);
      $('vault-status').textContent = `Removed ${button.dataset.remove}.`;
      renderSlots(next);
    });
  }
}

$('save-url').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('server-url');
  try {
    await setServerUrl(input.value.trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL);
    $('health').textContent = 'Saved.';
  } catch (err) {
    $('health').textContent = err instanceof Error ? err.message : String(err);
  }
});

$('test-url').addEventListener('click', async () => {
  $('health').textContent = 'Checking…';
  try {
    const report = await send({ type: 'athena:check-health' });
    $('health').textContent = `Reachable — provider "${report.provider}", ingress policy "${report.ingress_policy}".`;
  } catch (err) {
    $('health').textContent = `Unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
});

$('add-slot').addEventListener('click', async () => {
  const slotInput = $<HTMLInputElement>('new-slot');
  const valueInput = $<HTMLInputElement>('new-value');
  const slot = slotInput.value.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(slot)) {
    $('vault-status').textContent = 'Slot names may contain letters, digits, dot, dash and underscore.';
    return;
  }
  const next = { ...(await readVault()), [slot]: valueInput.value };
  await writeVault(next);
  slotInput.value = '';
  valueInput.value = '';
  $('vault-status').textContent = `Stored user_saved:${slot}.`;
  renderSlots(next);
});

$('open-options').addEventListener('click', () => {
  void api.runtime.openOptionsPage();
});

// --- lifecycle --------------------------------------------------------------

/** Tab switches and in-place navigations both invalidate the page context. */
let pageTimer: number | undefined;
function schedulePageRefresh(): void {
  window.clearTimeout(pageTimer);
  pageTimer = window.setTimeout(() => void refreshPageContext(), 120);
}
api.tabs.onActivated.addListener(schedulePageRefresh);
api.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'complete' || info.title !== undefined || info.url !== undefined) schedulePageRefresh();
});

void (async () => {
  renderActivity();
  try {
    $<HTMLInputElement>('server-url').value = await getServerUrl();
    renderSlots(await readVault());
  } catch (err) {
    $('health').textContent = `Could not read local settings: ${err instanceof Error ? err.message : String(err)}`;
  }

  await refreshPageContext();

  try {
    capture = await send({ type: 'athena:get-last-capture' });
    if (capture) {
      inspectedTabId = currentTabId;
      await rebuild();
      note('Restored the last capture from this session', 'info');
    }
  } catch {
    // A cold worker with no session storage is the normal first-run case.
  }
  renderAll();
  await refreshPageContext();
})();
