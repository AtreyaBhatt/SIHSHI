/**
 * Replays the production pipeline over every corpus screen and writes its
 * predictions, for run_eval.py to score.
 *
 * Imports the real modules the extension ships — capture, the detector cascade,
 * the redaction engine — so what is scored is what runs, not a reimplementation
 * that can drift.
 *
 * NOTE ON WHAT THE CORPUS MUST CONTAIN: this build's detectors are DOM-based, so
 * scoring needs the PAGE, not only a screenshot. A corpus entry whose `page_url`
 * does not resolve to a loadable page can only be scored for face detection.
 * corpus/README.md says so; it is a property of the approach, not an oversight.
 *
 * Usage:  node eval/predict.mjs [out.json]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '../extension');

// esbuild lives in the extension's dependency tree; borrow it rather than give
// /eval a second node_modules for one build call.
const { build } = createRequire(join(EXT, 'package.json'))('esbuild');
const SCREENS_DIR = join(HERE, 'corpus/screens');
const OUT = resolve(process.argv[2] ?? join(HERE, 'results/predictions.json'));

const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9341);
const THRESHOLD = Number(process.env.ATHENA_THRESHOLD ?? 0.5);

const workdir = await mkdtemp(join(tmpdir(), 'athena-predict-'));
const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
import { captureDomSnapshot } from '${join(EXT, 'src/capture/dom-snapshot.ts')}';
import { detectPii } from '${join(EXT, 'src/pii-detection/detect.ts')}';
import { buildAgentRequest } from '${join(EXT, 'src/redaction/build-request.ts')}';
import { TokenRegistry } from '${join(EXT, 'src/redaction/tokens.ts')}';

export async function predict(threshold) {
  const t0 = performance.now();
  const snapshot = captureDomSnapshot();
  const capture_ms = performance.now() - t0;

  const t1 = performance.now();
  const detections = detectPii(snapshot, { threshold });
  const detect_ms = performance.now() - t1;

  const t2 = performance.now();
  const { request } = await buildAgentRequest({
    snapshot, screenshotDataUrl: null, taskInstruction: 'eval',
    tokens: new TokenRegistry('eval-session'), threshold,
  });
  const redact_ms = performance.now() - t2;

  return {
    detections,
    manifest: request.redaction_manifest,
    dom_summary: request.dom_summary,
    node_count: snapshot.nodes.length,
    viewport: snapshot.viewport,
    timings: {
      capture_ms: Math.round(capture_ms * 100) / 100,
      detect_ms: Math.round(detect_ms * 100) / 100,
      redact_ms: Math.round(redact_ms * 100) / 100,
    },
  };
}
`);
await build({
  entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife',
  globalName: 'ATHENA', target: 'chrome116', logLevel: 'error', absWorkingDir: EXT,
});
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,800',
  '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${join(workdir, 'profile')}`, 'about:blank',
], { stdio: 'ignore' });

const results = {};
let socket;
let problems = 0;

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

  const files = (await readdir(SCREENS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  for (const file of files) {
    const screen = JSON.parse(await readFile(join(SCREENS_DIR, file), 'utf8'));
    const page = resolve(HERE, screen.page_url ?? '');

    if (!screen.page_url || !existsSync(page)) {
      console.error(`  skip ${screen.screen_id}: page_url does not resolve (${screen.page_url ?? 'absent'})`);
      results[screen.screen_id] = { unscorable: 'page not available; DOM detectors cannot be replayed' };
      problems++;
      continue;
    }

    await call('Page.navigate', { url: `file://${page}` });
    for (let i = 0; i < 50; i++) {
      await sleep(150);
      if ((await evaluate('document.readyState')) === 'complete' && (await evaluate('location.protocol')) === 'file:') break;
    }
    await sleep(350);
    await evaluate(bundle);

    results[screen.screen_id] = JSON.parse(
      await evaluate(`ATHENA.predict(${THRESHOLD}).then((r) => JSON.stringify(r))`),
    );
    const r = results[screen.screen_id];
    console.log(`  ${screen.screen_id}: ${r.detections.length} detections, ${r.manifest.length} redactions, ${r.timings.capture_ms + r.timings.detect_ms + r.timings.redact_ms} ms`);
  }
} catch (err) {
  console.error(`FAIL ${err.message}`);
  problems++;
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await sleep(150);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

await rm(dirname(OUT), { recursive: true, force: true }).catch(() => {});
await (await import('node:fs/promises')).mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify({ threshold: THRESHOLD, screens: results }, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
process.exit(problems === 0 ? 0 : 1);
