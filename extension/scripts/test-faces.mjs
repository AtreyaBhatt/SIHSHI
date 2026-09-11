/**
 * Proves the local face detector runs in a browser and finds faces.
 *
 * Serves the model, the ORT wasm artifacts and a test image over localhost,
 * loads them in real Chrome, and runs the same detectFaces() the extension
 * calls. Reports the execution provider ORT selected and the inference time,
 * which are two of the numbers PRD §8 asks for.
 *
 * The test image is not committed — it is a photograph of real people, and this
 * repository's rule is that real faces do not live in it. Fetch it first:
 *     npm run fetch:demo-faces
 *
 * Usage:  npm run test:faces
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
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9337);
const HTTP_PORT = Number(process.env.ATHENA_HTTP_PORT ?? 8899);
const ORT_EP = process.env.ATHENA_ORT_EP === 'webgpu' ? 'webgpu' : 'wasm';
const ORT_ARTIFACT = ORT_EP === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded';

const MODEL = resolve('models/version-RFB-320.onnx');
const IMAGE = resolve(process.argv[2] ?? '../eval/fixtures/assets/faces-2.jpg');

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };

for (const [what, path] of [['model', MODEL], ['test image', IMAGE]]) {
  if (!existsSync(path)) {
    console.error(`Missing ${what}: ${path}`);
    console.error(what === 'model' ? 'Run: npm run fetch:model' : 'Run: npm run fetch:demo-faces');
    process.exit(1);
  }
}

const root = await mkdtemp(join(tmpdir(), 'athena-faces-'));
await mkdir(join(root, 'ort'), { recursive: true });
await mkdir(join(root, 'models'), { recursive: true });

const entry = join(root, 'entry.ts');
await writeFile(entry, `
import { detectFaces } from '${resolve('src/perception/face-detect.ts')}';
export async function run(threshold) {
  const img = document.getElementById('pic');
  const result = await detectFaces(img, {
    modelUrl: '/models/version-RFB-320.onnx',
    wasmBaseUrl: '/ort/',
    threshold,
    scale: 1,
  });
  return { ...result, image: { width: img.naturalWidth, height: img.naturalHeight } };
}
`);
await build({
  entryPoints: [entry], outfile: join(root, 'bundle.js'), bundle: true, format: 'iife',
  globalName: 'ATHENA', target: 'chrome116', logLevel: 'error',
  conditions: ['onnxruntime-web-use-extern-wasm'],
  alias: ORT_EP === 'webgpu' ? {} : { 'onnxruntime-web': 'onnxruntime-web/wasm' },
});

for (const ext of ['.mjs', '.wasm']) {
  await cp(`node_modules/onnxruntime-web/dist/${ORT_ARTIFACT}${ext}`, join(root, 'ort', `${ORT_ARTIFACT}${ext}`));
}
await cp(MODEL, join(root, 'models', 'version-RFB-320.onnx'));
await cp(IMAGE, join(root, 'pic.jpg'));
await writeFile(join(root, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>face detector check</title>' +
  '<img id="pic" src="/pic.jpg" style="max-width:100%">' +
  '<script src="/bundle.js"></script>');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((ok) => server.listen(HTTP_PORT, '127.0.0.1', ok));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,800',
  '--no-first-run', '--hide-scrollbars', `--user-data-dir=${join(root, 'profile')}`,
  `http://127.0.0.1:${HTTP_PORT}/`,
], { stdio: 'ignore' });

let socket;
try {
  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try {
      pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page');
    } catch {}
    if (pages.length === 0) await sleep(250);
  }
  if (pages.length === 0) throw new Error('No face detector test page target');

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
    return new Promise((ok) => {
      pending.set(id, ok);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  await call('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
  const evaluate = async (expression) => {
    const id = ++nextId;
    const reply = await new Promise((ok) => {
      pending.set(id, ok);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };

  for (let i = 0; i < 60 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);
  for (let i = 0; i < 40 && !(await evaluate('typeof ATHENA !== "undefined"')); i++) await sleep(200);
  for (let i = 0; i < 40 && !(await evaluate('document.getElementById("pic")?.complete === true')); i++) await sleep(200);

  const result = JSON.parse(await evaluate(`ATHENA.run(0.6).then(r => JSON.stringify(r))`));

  console.log(`image        ${result.image.width}x${result.image.height}`);
  console.log(`provider     ${result.runtime.provider}`);
  console.log(`model        ${(result.runtime.model_bytes / 1048576).toFixed(2)} MB`);
  console.log(`session init ${result.runtime.init_ms} ms`);
  console.log(`inference    ${result.inference_ms} ms`);
  console.log(`faces        ${result.faces.length}\n`);

  if (result.faces.length > 0) pass(`detector found ${result.faces.length} face(s)`);
  else fail('detector found no faces in an image that contains them');

  const inBounds = result.faces.every(
    (f) => f.bbox[0] >= -2 && f.bbox[1] >= -2 && f.bbox[2] <= result.image.width + 2 && f.bbox[3] <= result.image.height + 2,
  );
  if (inBounds) pass('every box lies inside the image');
  else fail(`a box fell outside the image: ${JSON.stringify(result.faces.map((f) => f.bbox))}`);

  const wellFormed = result.faces.every((f) => f.bbox[2] > f.bbox[0] && f.bbox[3] > f.bbox[1] && f.score >= 0.6);
  if (wellFormed) pass('every box is non-degenerate and above threshold');
  else fail('a box was degenerate or below threshold');

  for (const face of result.faces.slice(0, 8)) {
    console.log(`       score ${face.score.toFixed(3)}  bbox ${face.bbox.join(', ')}`);
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
