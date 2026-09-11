/**
 * The demo view: raw screen, detections, and the exact payload, side by side.
 *
 * PRD §10 calls this diff "likely the single most persuasive artifact" for
 * judges, and the claim it has to support is a comparison — the third column is
 * only meaningful next to the first. A panel 400 px wide cannot show three
 * columns side by side, which is why this is a full page rather than more
 * sections in the panel.
 *
 * It runs in its own tab, so it must be told which tab to inspect: querying for
 * the active tab from here would capture the viewer looking at itself.
 */
import { api } from '../shared/browser';
import type { BBox, CaptureResult, RedactionManifestEntry } from '../shared/schema';
import type {
  ExecutionResult, PanelToWorker, PlanPreview, ResponseFor, WorkerReply,
} from '../shared/messages';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const targetTabId = (() => {
  const raw = new URLSearchParams(location.search).get('tab');
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
})();

let capture: CaptureResult | null = null;
let plan: PlanPreview | null = null;
let execution: ExecutionResult | null = null;

async function send<M extends PanelToWorker>(message: M): Promise<ResponseFor<M>> {
  const reply = (await api.runtime.sendMessage(message)) as WorkerReply<ResponseFor<M>>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setStatus(text: string, isError = false): void {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

interface Box { bbox: BBox; className: string; title: string }

function paintShot(container: HTMLElement, src: string | null, boxes: Box[], empty: string): void {
  container.innerHTML = '';
  if (!src) {
    container.innerHTML = `<p class="empty">${esc(empty)}</p>`;
    return;
  }
  const img = document.createElement('img');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const draw = (): void => {
    overlay.innerHTML = '';
    if (!capture) return;
    // Boxes are viewport CSS px; the image renders at whatever width the column
    // gives it, so scale by rendered width rather than devicePixelRatio.
    const scale = img.clientWidth / capture.snapshot.viewport.width;
    for (const box of boxes) {
      const [x1, y1, x2, y2] = box.bbox;
      const el = document.createElement('div');
      el.className = box.className;
      el.style.cssText = `left:${x1 * scale}px;top:${y1 * scale}px;width:${(x2 - x1) * scale}px;height:${(y2 - y1) * scale}px`;
      el.title = box.title;
      overlay.appendChild(el);
    }
  };
  img.addEventListener('load', draw);
  window.addEventListener('resize', draw);
  img.src = src;
  container.append(img, overlay);
}

function renderStats(): void {
  if (!capture) return;
  const preview = plan?.preview;
  const rows: Array<[string, string]> = [
    ['nodes', String(capture.snapshot.nodes.length)],
    ['detections', String(preview?.detections.length ?? 0)],
    ['redactions', String(preview?.request?.redaction_manifest.length ?? 0)],
    ['DOM walk', `${capture.timings.dom_walk_ms} ms`],
    ['screenshot', `${capture.timings.screenshot_ms} ms`],
    ['detect + redact', preview ? `${preview.build_ms} ms` : '—'],
    ['round trip', plan ? `${plan.network_ms} ms` : '—'],
    ['faces', preview?.perception_note ?? '—'],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<div class="stat">${k} <b>${esc(v)}</b></div>`).join('');
}

function renderColumns(): void {
  const preview = plan?.preview;
  const detections = preview?.detections ?? [];

  paintShot($('raw'), capture?.screenshot_data_url ?? null, [], 'No capture yet.');

  $('det-count').textContent = String(detections.length);
  paintShot(
    $('detected'),
    capture?.screenshot_data_url ?? null,
    detections.filter((d) => d.bbox).map((d) => ({
      bbox: d.bbox!,
      className: `b t${d.tier}`,
      title: `${d.type} · tier ${d.tier} · ${d.detector} · ${d.confidence}`,
    })),
    '—',
  );
  $('detections').innerHTML = detections.length
    ? detections.map((d) => `<div class="det tier${d.tier}">
        <span class="type">${esc(d.type)}</span>
        <span class="who">T${d.tier} · ${esc(d.detector)} · ${d.confidence}</span>
        <div class="path">${esc(d.node_path)}</div></div>`).join('')
    : '<p class="empty">Nothing above the threshold.</p>';

  const request = preview?.request ?? null;
  if (preview?.error || (preview && !request)) {
    $('sent-note').innerHTML = `<span class="tier1">Refused to build a payload — ${esc(preview.error ?? 'unknown')}</span>`;
  } else if (request) {
    $('sent-note').textContent = `${request.redaction_manifest.length} item(s) removed. This is the exact body that crossed the network.`;
  }

  paintShot(
    $('redacted'),
    request?.screenshot_redacted ? `data:image/png;base64,${request.screenshot_redacted}` : null,
    [],
    request ? 'No screenshot in this payload.' : '—',
  );

  const manifest: RedactionManifestEntry[] = request?.redaction_manifest ?? [];
  $('man-count').textContent = String(manifest.length);
  $('manifest').innerHTML = manifest.length
    ? `<table class="man"><thead><tr><th>id</th><th>T</th><th>type</th><th>masking</th><th>dom_path</th></tr></thead><tbody>${
        manifest.map((e) => `<tr><td>${esc(e.id)}</td><td class="tier${e.tier}">${e.tier}</td><td>${esc(e.type)}</td><td>${esc(e.masking)}</td><td>${esc(e.dom_path ?? '—')}</td></tr>`).join('')
      }</tbody></table>`
    : '<p class="empty">Nothing redacted.</p>';

  $('payload').textContent = request
    ? JSON.stringify(
        { ...request, screenshot_redacted: request.screenshot_redacted ? `<base64 PNG, ${request.screenshot_redacted.length} chars>` : null },
        null,
        1,
      )
    : '—';
}

function renderPlan(): void {
  const body = $('plan');
  if (!plan) { body.innerHTML = '<p class="empty">No plan yet.</p>'; return; }
  if (plan.error || !plan.response) {
    body.innerHTML = `<div class="banner blocked"><strong>No plan.</strong> ${esc(plan.error ?? 'unknown')}</div>`;
    return;
  }
  const response = plan.response;
  const outcomes = execution?.outcomes ?? [];

  const rejections = response.guardrail_rejections?.length
    ? `<div class="banner blocked"><strong>Server guardrails dropped ${response.guardrail_rejections.length} action(s):</strong> ${response.guardrail_rejections.map(esc).join('<br />')}</div>`
    : '';

  const actions = response.actions.map((action, i) => {
    const outcome = outcomes[i];
    const status = outcome ? (outcome.ok ? `ok ${outcome.duration_ms} ms` : `failed — ${esc(outcome.error ?? '')}`) : '';
    // A value_ref shows as the slot name. Resolving it here would put the secret
    // in the DOM of a page this very extension can screenshot.
    const source = action.value_ref
      ? `<span class="ref">${esc(action.value_ref)}</span>`
      // The server sends `value: null` for a value_ref action, so `!== undefined`
      // lets null through — JSON round-trips absence as null, not undefined.
      : typeof action.value === 'string' ? `"${esc(action.value)}"` : '';
    return `<div class="act${outcome && !outcome.ok ? ' failed' : ''}">
      <span class="verb">${esc(action.action)}</span><span class="sel">${esc(action.selector ?? '—')}</span>${source}
      <span class="outcome">${status}</span></div>`;
  }).join('');

  body.innerHTML = `<div class="summary">${esc(response.reasoning_summary)}</div>${rejections}
    ${actions || '<p class="empty">The planner returned no actions.</p>'}
    <div style="margin-top:10px"><button id="execute" class="primary"${response.actions.length ? '' : ' disabled'}>Execute on the live page</button>
    <span class="note" style="margin-left:10px">${response.requires_client_secret ? 'resolves a local credential at execution time' : ''}</span></div>`;

  document.getElementById('execute')?.addEventListener('click', async () => {
    setStatus('Executing…');
    try {
      execution = await send({ type: 'ppva:execute-plan', tab_id: targetTabId });
      const failed = execution.outcomes.filter((o) => !o.ok).length;
      setStatus(failed ? `${failed} action(s) failed.` : `Executed in ${execution.execute_ms} ms.`, failed > 0);
      renderPlan();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  });
}

function renderAll(): void { renderStats(); renderColumns(); renderPlan(); }

$('run').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('run');
  button.disabled = true;
  execution = null;
  setStatus('Capturing, redacting, sending…');
  try {
    capture = await send({ type: 'ppva:run-capture', tab_id: targetTabId });
    plan = await send({
      type: 'ppva:request-plan',
      threshold: Number($<HTMLInputElement>('threshold').value),
      task_instruction: $<HTMLInputElement>('task').value,
      tab_id: targetTabId,
    });
    $('session-id').textContent = plan.preview.session_id.slice(0, 8);
    renderAll();
    setStatus(plan.error ? plan.error : `Done in ${plan.network_ms} ms round trip.`, Boolean(plan.error));
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    button.disabled = false;
  }
});

$('threshold').addEventListener('input', () => {
  $('thr-value').textContent = Number($<HTMLInputElement>('threshold').value).toFixed(2);
});

if (targetTabId === undefined) {
  setStatus('Opened without a target tab — open this view from the PPVA side panel so it knows which page to inspect.', true);
}
