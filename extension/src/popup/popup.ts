/**
 * The diff viewer, in skeleton form.
 *
 * PRD §10 calls the side-by-side "what was on screen / what was detected / what
 * was sent" view the most persuasive artifact for judges. It is also the only
 * practical way to debug the detector cascade in M2, which is why it exists on
 * day one rather than during demo polish.
 *
 * Right now it shows two of the three panes honestly and refuses to fake the
 * third: with no redaction engine there is no sanitized payload, so the outbound
 * pane says so rather than displaying raw capture under a misleading heading.
 */
import { api } from '../shared/browser';
import type { CaptureResult, RawDomNode } from '../shared/schema';
import type { PopupToWorker, WorkerToPopup } from '../shared/messages';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const captureBtn = $<HTMLButtonElement>('capture');
const showBoxes = $<HTMLInputElement>('show-boxes');
const shotWrap = $<HTMLDivElement>('shot-wrap');
const nodesEl = $<HTMLDivElement>('nodes');
const nodeCount = $<HTMLSpanElement>('node-count');
const statsEl = $<HTMLDivElement>('stats');
const statusEl = $<HTMLDivElement>('status');

let current: CaptureResult | null = null;

function send(message: PopupToWorker): Promise<WorkerToPopup> {
  return api.runtime.sendMessage(message) as Promise<WorkerToPopup>;
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// --- panes -----------------------------------------------------------------

function renderStats(capture: CaptureResult): void {
  const { snapshot, timings } = capture;
  const interactive = snapshot.nodes.filter((n) => n.interactive).length;
  const media = snapshot.nodes.filter((n) => n.media).length;
  const stats: Array<[string, string]> = [
    ['nodes', `${snapshot.nodes.length}${snapshot.truncated ? ' (truncated)' : ''}`],
    ['interactive', String(interactive)],
    ['media', String(media)],
    ['DOM walk', `${timings.dom_walk_ms} ms`],
    ['screenshot', `${timings.screenshot_ms} ms`],
    ['total', `${timings.total_ms} ms`],
    ['viewport', `${snapshot.viewport.width}×${snapshot.viewport.height} @${snapshot.viewport.device_pixel_ratio}x`],
  ];
  statsEl.innerHTML = stats.map(([k, v]) => `<div class="stat">${k} <b>${escapeHtml(v)}</b></div>`).join('');
  statsEl.classList.remove('hidden');
}

function renderScreenshot(capture: CaptureResult): void {
  const { screenshot_data_url: url, screenshot_error: err, snapshot } = capture;
  if (!url) {
    shotWrap.innerHTML = `<p class="empty">No screenshot — ${escapeHtml(err ?? 'unavailable')}.<br />The DOM snapshot is still usable.</p>`;
    return;
  }

  shotWrap.innerHTML = '';
  const img = document.createElement('img');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  // bboxes are viewport CSS px; the screenshot renders at whatever width the
  // popup gives it, so scale by the rendered width rather than the DPR.
  const draw = (): void => {
    overlay.innerHTML = '';
    if (!showBoxes.checked) return;
    const scale = img.clientWidth / snapshot.viewport.width;
    for (const node of snapshot.nodes) {
      const [x1, y1, x2, y2] = node.bbox;
      const box = document.createElement('div');
      box.className = node.interactive ? 'b interactive' : 'b';
      box.style.left = `${x1 * scale}px`;
      box.style.top = `${y1 * scale}px`;
      box.style.width = `${(x2 - x1) * scale}px`;
      box.style.height = `${(y2 - y1) * scale}px`;
      box.title = `${node.path}${node.label ? ` — ${node.label}` : ''}`;
      overlay.appendChild(box);
    }
  };

  img.addEventListener('load', draw);
  img.src = url;
  shotWrap.append(img, overlay);
  showBoxes.onchange = draw;
}

function renderNode(node: RawDomNode): string {
  const meta: string[] = [`<span>&lt;${escapeHtml(node.tag)}&gt;</span>`];
  if (node.role) meta.push(`<span>role=${escapeHtml(node.role)}</span>`);
  if (node.input_type) meta.push(`<span>type=${escapeHtml(node.input_type)}</span>`);
  if (node.attrs.name) meta.push(`<span>name=${escapeHtml(node.attrs.name)}</span>`);
  if (node.attrs.autocomplete) meta.push(`<span>ac=${escapeHtml(node.attrs.autocomplete)}</span>`);
  if (node.media) meta.push(`<span>media=${escapeHtml(node.media)}</span>`);

  let val = '';
  if (node.value_omitted) {
    val = `<div class="val omitted">value omitted at capture (${escapeHtml(node.value_omitted)})</div>`;
  } else if (node.value) {
    val = `<div class="val">value: ${escapeHtml(node.value)}</div>`;
  } else if (node.text) {
    val = `<div class="val">text: ${escapeHtml(node.text)}</div>`;
  }

  const label = node.label ? `<div class="meta"><span>label: ${escapeHtml(node.label)}</span></div>` : '';
  return `<div class="node"><div class="path">${escapeHtml(node.path)}</div><div class="meta">${meta.join('')}</div>${label}${val}</div>`;
}

function renderNodes(capture: CaptureResult): void {
  const { nodes } = capture.snapshot;
  nodeCount.textContent = String(nodes.length);
  nodesEl.innerHTML = nodes.length
    ? nodes.map(renderNode).join('')
    : '<p class="empty">Snapshot contained no visible nodes.</p>';
}

function render(capture: CaptureResult | null): void {
  current = capture;
  if (!capture) return;
  renderStats(capture);
  renderScreenshot(capture);
  renderNodes(capture);
}

// --- wiring ----------------------------------------------------------------

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  setStatus('Capturing…');
  try {
    const res = await send({ type: 'ppva:run-capture' });
    if (!res.ok) throw new Error(res.error);
    render(res.capture);
    const t = res.capture?.timings;
    setStatus(t ? `Captured in ${t.total_ms} ms — nothing sent.` : 'Captured.');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    captureBtn.disabled = false;
  }
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.pane!).classList.add('active');
    // The screenshot has no layout width while its pane is hidden, so boxes
    // must be re-laid-out when the pane becomes visible.
    if (tab.dataset.pane === 'pane-capture' && current) renderScreenshot(current);
  });
}

void (async () => {
  const res = await send({ type: 'ppva:get-last-capture' });
  if (res.ok && res.capture) {
    render(res.capture);
    setStatus('Showing last capture from this session.');
  } else {
    setStatus('Ready.');
  }
})();
