/**
 * Scenario B (PRD §10): faces are gone before the screenshot leaves the machine.
 *
 * Screenshots the video-call fixture, runs the local detector, blurs every face
 * through the real redaction engine, and then RUNS THE DETECTOR AGAIN on the
 * redacted image. "The faces are blurred" is an assertion you can actually make
 * that way: whatever the first pass could find, the second pass must not.
 *
 * Also checks the other half of the scenario — that enough structure survives
 * for the agent to find the Mute button.
 *
 * Needs the uncommitted test photograph: npm run fetch:demo-faces
 *
 * Usage:  npm run test:scenario-b
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9338);
const HTTP_PORT = Number(process.env.ATHENA_HTTP_PORT ?? 8898);
const ORT_EP = process.env.ATHENA_ORT_EP === 'webgpu' ? 'webgpu' : 'wasm';
const ORT_ARTIFACT = ORT_EP === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded';

const MODEL = resolve('models/version-RFB-320.onnx');
const FIXTURE_DIR = resolve('../eval/fixtures');
const PHOTO = join(FIXTURE_DIR, 'assets/faces-2.jpg');

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };

if (!existsSync(MODEL)) { console.error('Missing model. Run: npm run fetch:model'); process.exit(1); }
if (!existsSync(PHOTO)) { console.error('Missing test photo. Run: npm run fetch:demo-faces'); process.exit(1); }

const root = await mkdtemp(join(tmpdir(), 'athena-scenb-'));
await mkdir(join(root, 'ort'), { recursive: true });
await mkdir(join(root, 'models'), { recursive: true });
await cp(FIXTURE_DIR, root, { recursive: true });
for (const ext of ['.mjs', '.wasm']) {
  await cp(`node_modules/onnxruntime-web/dist/${ORT_ARTIFACT}${ext}`, join(root, 'ort', `${ORT_ARTIFACT}${ext}`));
}
await cp(MODEL, join(root, 'models', 'version-RFB-320.onnx'));

const entry = join(root, 'entry.ts');
await writeFile(entry, `
import { detectFaces } from '${resolve('src/perception/face-detect.ts')}';
import { redactScreenshot } from '${resolve('src/redaction/redact-image.ts')}';
import { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';

const OPTS = { modelUrl: '/models/version-RFB-320.onnx', wasmBaseUrl: '/ort/' };

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export async function analyse(shotDataUrl) {
  const snapshot = captureDomSnapshot();
  const bitmap = await createImageBitmap(dataUrlToBlob(shotDataUrl));
  const cssPerDevice = snapshot.viewport.width / bitmap.width;

  const before = await detectFaces(bitmap, { ...OPTS, scale: cssPerDevice });

  const regions = before.faces.map((f) => ({ bbox: f.bbox, masking: 'blur' }));
  const redactedB64 = await redactScreenshot(shotDataUrl, regions, snapshot.viewport.width);

  const redactedBitmap = await createImageBitmap(dataUrlToBlob('data:image/png;base64,' + redactedB64));
  const after = await detectFaces(redactedBitmap, { ...OPTS, scale: cssPerDevice });

  bitmap.close(); redactedBitmap.close();
  return {
    before: before.faces, after: after.faces,
    provider: before.runtime.provider,
    inference_ms: before.inference_ms,
    init_ms: before.runtime.init_ms,
    nodes: snapshot.nodes.map((n) => ({ path: n.path, role: n.role, label: n.label })),
    viewport: snapshot.viewport,
    redacted_bytes: redactedB64.length,
  };
}
`);
await build({
  entryPoints: [entry], outfile: join(root, 'bundle.js'), bundle: true, format: 'iife',
  globalName: 'ATHENA', target: 'chrome116', logLevel: 'error',
  conditions: ['onnxruntime-web-use-extern-wasm'],
  alias: ORT_EP === 'webgpu' ? {} : { 'onnxruntime-web': 'onnxruntime-web/wasm' },
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((ok) => server.listen(HTTP_PORT, '127.0.0.1', ok));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,800',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${join(root, 'profile')}`,
  `http://127.0.0.1:${HTTP_PORT}/video-call.html`,
], { stdio: 'ignore' });

let socket;
try {
  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (pages.length === 0) await sleep(250);
  }
  if (pages.length === 0) throw new Error('No Chrome page target');

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

  for (let i = 0; i < 60 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);
  await sleep(500); // let the tile backgrounds paint
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const shotDataUrl = `data:image/png;base64,${shot.result.data}`;

  await evaluate(await readFile(join(root, 'bundle.js'), 'utf8'));
  const r = JSON.parse(await evaluate(`ATHENA.analyse(${JSON.stringify(shotDataUrl)}).then(x => JSON.stringify(x))`));

  console.log(`viewport     ${r.viewport.width}x${r.viewport.height}`);
  console.log(`provider     ${r.provider} · init ${r.init_ms} ms · inference ${r.inference_ms} ms`);
  console.log(`faces        ${r.before.length} before redaction → ${r.after.length} after\n`);

  if (r.before.length >= 4) pass(`detector found ${r.before.length} face(s) on the call grid`);
  else fail(`only ${r.before.length} face(s) found — expected one per participant tile`);

  if (r.after.length === 0) pass('after blurring, the detector finds none of them');
  else fail(`${r.after.length} face(s) still detectable in the redacted screenshot`);

  console.log('\nstructure survives for the agent to act on:');
  const byPath = new Map(r.nodes.map((n) => [n.path, n]));
  for (const [name, selector] of [['mute button', 'button#mute'], ['leave button', 'button#leave'], ['share button', 'button#share']]) {
    const node = byPath.get(selector);
    if (node && node.label) pass(`${name} present with label "${node.label}"`);
    else fail(`${name} (${selector}) missing from the snapshot`);
  }
} catch (err) {
  fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  server.close();
  await sleep(150);
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
