/**
 * The diff viewer (PRD §10): raw screen → what was detected → what would be sent.
 *
 * It is the demo artifact and the debugging tool for the detector cascade, which
 * is why the three panes stay honest about failure: when the redaction engine
 * refuses to build a payload, the outbound pane shows the refusal, never the
 * raw capture under a friendlier heading.
 */
import { api } from '../shared/browser';
import type { BBox, CaptureResult, RedactionManifestEntry } from '../shared/schema';
import type { PayloadPreview, PopupToWorker, ResponseFor, WorkerReply } from '../shared/messages';
import type { Detection } from '../pii-detection/types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const captureBtn = $<HTMLButtonElement>('capture');
const showBoxes = $<HTMLInputElement>('show-boxes');
const thresholdInput = $<HTMLInputElement>('threshold');
const thresholdValue = $<HTMLElement>('thr-value');
const statusEl = $<HTMLElement>('status');
const sessionEl = $<HTMLElement>('session-id');

let capture: CaptureResult | null = null;
let preview: PayloadPreview | null = null;

async function send<M extends PopupToWorker>(message: M): Promise<ResponseFor<M>> {
  const reply = (await api.runtime.sendMessage(message)) as WorkerReply<ResponseFor<M>>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// --- shared screenshot + overlay -------------------------------------------

interface Box {
  bbox: BBox;
  className: string;
  title: string;
}

/**
 * Boxes are viewport CSS pixels; the image renders at whatever width the pane
 * gives it, so scale by the rendered width rather than by devicePixelRatio.
 */
function paintShot(container: HTMLElement, imageSrc: string | null, boxes: Box[], emptyMessage: string): void {
  container.innerHTML = '';
  if (!imageSrc) {
    container.innerHTML = `<p class="empty">${esc(emptyMessage)}</p>`;
    return;
  }
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

// --- panes ------------------------------------------------------------------

function renderStats(): void {
  if (!capture) return;
  const { snapshot, timings } = capture;
  const rows: Array<[string, string]> = [
    ['nodes', `${snapshot.nodes.length}${snapshot.truncated ? ' (truncated)' : ''}`],
    ['DOM walk', `${timings.dom_walk_ms} ms`],
    ['screenshot', `${timings.screenshot_ms} ms`],
    ['detect + redact', preview ? `${preview.build_ms} ms` : '—'],
    ['viewport', `${snapshot.viewport.width}×${snapshot.viewport.height}`],
  ];
  const el = $('stats');
  el.innerHTML = rows.map(([k, v]) => `<div class="stat">${k} <b>${esc(v)}</b></div>`).join('');
  el.classList.remove('hidden');
}

function renderRawPane(): void {
  const boxes: Box[] = showBoxes.checked && capture
    ? capture.snapshot.nodes.map((n) => ({
        bbox: n.bbox,
        className: n.interactive ? 'b interactive' : 'b',
        title: `${n.path}${n.label ? ` — ${n.label}` : ''}`,
      }))
    : [];
  paintShot($('shot-wrap'), capture?.screenshot_data_url ?? null, boxes,
    capture ? `No screenshot — ${capture.screenshot_error ?? 'unavailable'}. The DOM snapshot is still usable.` : 'No capture yet.');
}

function renderDetectionsPane(): void {
  const detections = preview?.detections ?? [];
  $('det-count').textContent = String(detections.length);

  paintShot(
    $('det-shot'),
    capture?.screenshot_data_url ?? null,
    detections.map((d) => ({
      bbox: d.bbox ?? [0, 0, 0, 0],
      className: `b t${d.tier}`,
      title: `${d.type} (tier ${d.tier}) · ${d.detector} · ${d.confidence}`,
    })),
    'No capture yet.',
  );

  const list = $('detections');
  if (detections.length === 0) {
    list.innerHTML = capture
      ? '<p class="empty">Nothing above the threshold on this screen.</p>'
      : '<p class="empty">No capture yet.</p>';
    return;
  }
  list.innerHTML = detections
    .map((d: Detection) => `
      <div class="det tier${d.tier}">
        <div class="head">
          <span class="type">${esc(d.type)}</span>
          <span class="who">tier ${d.tier} · ${esc(d.detector)} · conf ${d.confidence}</span>
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

function renderOutboundPane(): void {
  const statusBox = $('outbound-status');
  const body = $('outbound-body');

  if (!preview) {
    statusBox.innerHTML = '<p class="empty">No capture yet.</p>';
    body.classList.add('hidden');
    return;
  }
  if (preview.error || !preview.request) {
    statusBox.innerHTML = `<div class="banner blocked"><strong>Refused to build a payload.</strong> ${esc(preview.error ?? 'unknown')}</div>`;
    body.classList.add('hidden');
    return;
  }

  const request = preview.request;
  statusBox.innerHTML = `<div class="banner ok"><strong>Payload built in ${preview.build_ms} ms.</strong>
    ${request.redaction_manifest.length} item(s) redacted. Displayed only — nothing is sent.</div>`;
  body.classList.remove('hidden');

  paintShot(
    $('redacted-wrap'),
    request.screenshot_redacted ? `data:image/png;base64,${request.screenshot_redacted}` : null,
    [],
    'No screenshot was captured, so there is none to redact.',
  );

  $('man-count').textContent = String(request.redaction_manifest.length);
  $('manifest').innerHTML = request.redaction_manifest.length
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

function renderAll(): void {
  renderStats();
  renderRawPane();
  renderDetectionsPane();
  renderOutboundPane();
}

// --- actions ----------------------------------------------------------------

async function rebuild(): Promise<void> {
  if (!capture) return;
  preview = await send({
    type: 'ppva:build-payload',
    threshold: Number(thresholdInput.value),
    task_instruction: 'Describe this screen and identify the next action.',
  });
  sessionEl.textContent = preview.session_id.slice(0, 8);
  renderAll();
}

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  setStatus('Capturing…');
  try {
    capture = await send({ type: 'ppva:run-capture' });
    await rebuild();
    const redacted = preview?.request?.redaction_manifest.length ?? 0;
    setStatus(`${capture.snapshot.nodes.length} nodes · ${preview?.detections.length ?? 0} detections · ${redacted} redacted · nothing sent.`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    captureBtn.disabled = false;
  }
});

let rebuildTimer: number | undefined;
thresholdInput.addEventListener('input', () => {
  thresholdValue.textContent = Number(thresholdInput.value).toFixed(2);
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    rebuild().catch((err) => setStatus(String(err), true));
  }, 120);
});

showBoxes.addEventListener('change', renderRawPane);

$('reset-session').addEventListener('click', async () => {
  const { session_id } = await send({ type: 'ppva:reset-session' });
  sessionEl.textContent = session_id.slice(0, 8);
  setStatus('New session — token mapping discarded.');
  await rebuild();
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.pane!).classList.add('active');
    // Images have no layout width while their pane is hidden, so overlays must
    // be re-laid-out when one becomes visible.
    renderAll();
  });
}

void (async () => {
  try {
    capture = await send({ type: 'ppva:get-last-capture' });
    if (capture) {
      await rebuild();
      setStatus('Showing last capture from this session.');
    } else {
      setStatus('Ready.');
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
})();
