/**
 * Measures every stage of the pipeline, N times, and emits raw per-run timings
 * for latency_bench.py to turn into a waterfall with p50/p95.
 *
 * Stages, in the order PRD §8 asks for them:
 *   capture      DOM walk into a serialized snapshot
 *   screenshot   pixels off the tab
 *   perception   local face detection (ONNX Runtime Web)
 *   redaction    text masking, manifest, pixel compositing
 *   network      HTTP round trip to the reasoning server
 *   execute      actions applied to the live DOM
 *
 * Two honest notes about what these numbers are:
 *
 *  - `screenshot` here is CDP's Page.captureScreenshot, not the extension's
 *    chrome.tabs.captureVisibleTab. Same work, different caller; treat it as an
 *    approximation of that stage rather than a measurement of it.
 *  - `network` against the mock provider is transport only. Server reasoning is
 *    a VLM call and will dominate the total in a real run — that is the point of
 *    the split, and the waterfall is what shows it.
 *
 * Usage:  node eval/latency_stages.mjs [runs] [out.json]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '../extension');
const SERVER_DIR = resolve(HERE, '../server');
const { build } = createRequire(join(EXT, 'package.json'))('esbuild');

const RUNS = Number(process.argv[2] ?? 10);
const OUT = resolve(process.argv[3] ?? join(HERE, 'results/latency.json'));
const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9342);
const HTTP_PORT = Number(process.env.ATHENA_HTTP_PORT ?? 8897);
const SERVER_PORT = Number(process.env.ATHENA_SERVER_PORT ?? 8789);
const ORT_ARTIFACT = process.env.ATHENA_ORT_EP === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded';

const MODEL = join(EXT, 'models/version-RFB-320.onnx');
const haveModel = existsSync(MODEL);

const root = await mkdtemp(join(tmpdir(), 'athena-latency-'));
await mkdir(join(root, 'ort'), { recursive: true });
await mkdir(join(root, 'models'), { recursive: true });
await cp(join(HERE, 'fixtures'), root, { recursive: true });
for (const ext of ['.mjs', '.wasm']) {
  await cp(join(EXT, `node_modules/onnxruntime-web/dist/${ORT_ARTIFACT}${ext}`), join(root, 'ort', `${ORT_ARTIFACT}${ext}`));
}
if (haveModel) await cp(MODEL, join(root, 'models/version-RFB-320.onnx'));

const entry = join(root, 'entry.ts');
await writeFile(entry, `
import { captureDomSnapshot } from '${join(EXT, 'src/capture/dom-snapshot.ts')}';
import { buildAgentRequest } from '${join(EXT, 'src/redaction/build-request.ts')}';
import { TokenRegistry } from '${join(EXT, 'src/redaction/tokens.ts')}';
import { detectFaces } from '${join(EXT, 'src/perception/face-detect.ts')}';
import { executeActions } from '${join(EXT, 'src/executor/execute.ts')}';

const OPTS = { modelUrl: '/models/version-RFB-320.onnx', wasmBaseUrl: '/ort/' };
const tokens = new TokenRegistry('bench-session');

function dataUrlToBlob(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export async function warmPerception() {
  if (!${haveModel}) return { skipped: true };
  const c = new OffscreenCanvas(320, 240);
  c.getContext('2d').fillRect(0, 0, 320, 240);
  const t = performance.now();
  await detectFaces(c, OPTS);
  return { init_ms: performance.now() - t };
}

export async function run(shotDataUrl) {
  const t0 = performance.now();
  const snapshot = captureDomSnapshot();
  const capture_ms = performance.now() - t0;

  let perception_ms = 0;
  let perception_preprocess_ms = 0;
  let perception_inference_ms = 0;
  let faces = [];
  if (${haveModel} && shotDataUrl) {
    const bitmap = await createImageBitmap(dataUrlToBlob(shotDataUrl));
    const t1 = performance.now();
    const r = await detectFaces(bitmap, { ...OPTS, scale: snapshot.viewport.width / bitmap.width });
    perception_ms = performance.now() - t1;
    perception_preprocess_ms = r.preprocess_ms;
    perception_inference_ms = r.inference_ms;
    faces = r.faces;
    bitmap.close();
  }

  const t2 = performance.now();
  const { request } = await buildAgentRequest({
    snapshot, screenshotDataUrl: shotDataUrl, taskInstruction: 'Log me in to this portal.',
    tokens, threshold: 0.5, faces,
  });
  const redaction_ms = performance.now() - t2;

  return {
    capture_ms, perception_ms, perception_preprocess_ms, perception_inference_ms,
    redaction_ms, request, faces: faces.length,
  };
}

export async function execute(actions, allowed) {
  const t = performance.now();
  const outcomes = await executeActions(actions, allowed);
  return { execute_ms: performance.now() - t, ok: outcomes.every((o) => o.ok) };
}
`);
await build({
  entryPoints: [entry], outfile: join(root, 'bundle.js'), bundle: true, format: 'iife',
  globalName: 'ATHENA', target: 'chrome116', logLevel: 'error', absWorkingDir: EXT,
  conditions: ['onnxruntime-web-use-extern-wasm'],
  alias: process.env.ATHENA_ORT_EP === 'webgpu' ? {} : { 'onnxruntime-web': 'onnxruntime-web/wasm' },
});
const bundle = await readFile(join(root, 'bundle.js'), 'utf8');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png' };
const fileServer = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((ok) => fileServer.listen(HTTP_PORT, '127.0.0.1', ok));

const server = spawn('uv', ['run', 'uvicorn', 'main:app', '--port', String(SERVER_PORT), '--log-level', 'warning'], { cwd: SERVER_DIR, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,800',
  '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${join(root, 'profile')}`, `http://127.0.0.1:${HTTP_PORT}/bank-login.html`,
], { stdio: 'ignore' });

const runs = [];
let socket;
let provider = 'unknown';
let perceptionInit = null;

try {
  let health = null;
  for (let i = 0; i < 80 && !health; i++) {
    try { health = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`)).json(); } catch { await sleep(250); }
  }
  if (!health) throw new Error('server did not start');
  provider = health.provider;

  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (pages.length === 0) await sleep(250);
  }
  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = () => no(new Error('CDP connect failed')); });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => {
    const id = ++nextId;
    return new Promise((ok) => { pending.set(id, ok); socket.send(JSON.stringify({ id, method, params })); });
  };
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };
  const load = async () => {
    await call('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/bank-login.html` });
    for (let i = 0; i < 50; i++) {
      await sleep(120);
      if ((await evaluate('document.readyState')) === 'complete' && (await evaluate('typeof ATHENA'))) break;
    }
    await evaluate(bundle);
    // Each run reloads the page, which discards the cached ONNX session. The
    // extension's offscreen document persists, so re-creating the session inside
    // the measured window would report ~100 ms of init as if it were per-capture
    // cost. Warm it here and measure steady state, which is what the extension
    // actually does.
    await evaluate('ATHENA.warmPerception().then(r => JSON.stringify(r))');
  };

  // Session init is a one-time cost per worker lifetime; measured once on a cold
  // context and reported separately so it is not smeared across steady-state runs.
  await call('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/bank-login.html` });
  for (let i = 0; i < 50; i++) {
    await sleep(120);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await evaluate(bundle);
  perceptionInit = JSON.parse(await evaluate('ATHENA.warmPerception().then(r => JSON.stringify(r))'));

  for (let i = 0; i < RUNS; i++) {
    await load();

    const tShot = Date.now();
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    const screenshot_ms = Date.now() - tShot;
    const shotDataUrl = `data:image/png;base64,${shot.result.data}`;

    const local = JSON.parse(await evaluate(`ATHENA.run(${JSON.stringify(shotDataUrl)}).then(r => JSON.stringify(r))`));

    const tNet = Date.now();
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/agent/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(local.request),
    });
    const plan = await response.json();
    const network_ms = Date.now() - tNet;

    const actions = plan.actions.filter((a) => a.action !== 'click').map((a) => ({
      action: a.action, selector: a.selector, value: a.value_ref ? 'bench-value' : a.value,
    }));
    const allowed = local.request.dom_summary.map((n) => n.path);
    const exec = JSON.parse(await evaluate(
      `ATHENA.execute(${JSON.stringify(actions)}, ${JSON.stringify(allowed)}).then(r => JSON.stringify(r))`,
    ));

    runs.push({
      capture_ms: local.capture_ms,
      screenshot_ms,
      perception_ms: local.perception_ms,
      perception_preprocess_ms: local.perception_preprocess_ms,
      perception_inference_ms: local.perception_inference_ms,
      redaction_ms: local.redaction_ms,
      network_ms,
      execute_ms: exec.execute_ms,
      faces: local.faces,
      payload_bytes: JSON.stringify(local.request).length,
      actions: plan.actions.length,
    });
    process.stderr.write(`  run ${i + 1}/${RUNS}\r`);
  }
} catch (err) {
  console.error(`FAIL ${err.message}`);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  server.kill('SIGTERM');
  fileServer.close();
  await sleep(200);
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify({
  provider,
  model_present: haveModel,
  perception_init_ms: perceptionInit?.init_ms ?? null,
  runs,
}, null, 2)}\n`);
console.error(`\nwrote ${OUT} (${runs.length} runs)`);
process.exit(runs.length > 0 ? 0 : 1);
