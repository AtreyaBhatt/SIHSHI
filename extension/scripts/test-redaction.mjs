/**
 * End-to-end check of the privacy property, run in real Chrome against a fixture.
 *
 * Captures the page, runs the detector cascade, builds the §7.1 payload, and
 * then greps the serialized payload for every value planted in the fixture. A
 * single hit is a leak and fails the run — this is the assertion the whole
 * project exists to satisfy, so it is checked mechanically rather than by eye.
 *
 * The complementary risk is over-redaction, which costs precision points and
 * breaks the agent's ability to do the task, so the structural strings the
 * server needs are asserted present in the same pass.
 *
 * Image redaction needs captureVisibleTab and is exercised in the extension;
 * this covers the text/DOM half.
 *
 * Usage:  npm run test:redaction
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const CHROME = process.env.PPVA_CHROME ?? 'google-chrome-stable';
const PORT = Number(process.env.PPVA_CDP_PORT ?? 9334);
const fixture = resolve(process.argv[2] ?? '../eval/fixtures/bank-login.html');

/** Every sensitive string planted in bank-login.html, in each form it appears. */
const MUST_NOT_APPEAR = [
  ['password', 'hunter2-not-real'],
  ['PAN', 'ABCDE1234F'],
  ['account number', '50100247716839'],
  ['IFSC', 'MERD0001234'],
  ['card (spaced)', '4539 1488 0343 6467'],
  ['card (bare)', '4539148803436467'],
  ['email', 'ada.lovelace@example.org'],
  ['phone', '98765 43210'],
  ['person name', 'Ada Lovelace'],
];

/** Structure the server needs in order to reason — losing these is over-redaction. */
const MUST_APPEAR = [
  ['password label', 'NetBanking password'],
  ['submit button label', 'Sign in'],
  ['heading', 'Sign in to NetBanking'],
  ['field label', 'Registered mobile'],
];

const workdir = await mkdtemp(join(tmpdir(), 'ppva-redaction-'));
const entry = join(workdir, 'entry.ts');
const bundlePath = join(workdir, 'bundle.js');

await writeFile(entry, `
import { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
import { buildAgentRequest } from '${resolve('src/redaction/build-request.ts')}';
import { TokenRegistry } from '${resolve('src/redaction/tokens.ts')}';
export async function run(threshold) {
  const snapshot = captureDomSnapshot();
  const { request, detections } = await buildAgentRequest({
    snapshot,
    screenshotDataUrl: null,
    taskInstruction: 'Log me in.',
    tokens: new TokenRegistry('test-session'),
    threshold,
  });
  return { request, detections, nodes: snapshot.nodes.length };
}
`);

await build({ entryPoints: [entry], outfile: bundlePath, bundle: true, format: 'iife', globalName: 'PPVA', target: 'chrome116', logLevel: 'error' });
const bundle = await readFile(bundlePath, 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1280,800',
  '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${join(workdir, 'profile')}`, `file://${fixture}`,
], { stdio: 'ignore' });

let socket;
let failures = 0;
const pass = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { failures++; console.error(`  FAIL ${msg}`); };

try {
  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (pages.length === 0) await sleep(250);
  }
  if (pages.length === 0) throw new Error(`No page target on :${PORT}`);

  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = () => no(new Error('CDP connect failed')); });

  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const evaluate = async (expression) => {
    const id = ++nextId;
    const reply = await new Promise((ok) => {
      pending.set(id, ok);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };

  for (let i = 0; i < 40 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);

  const result = JSON.parse(await evaluate(`${bundle}; PPVA.run(0.5).then(r => JSON.stringify(r))`));
  const payload = JSON.stringify(result.request);

  console.log(`fixture      ${fixture}`);
  console.log(`nodes        ${result.nodes}`);
  console.log(`detections   ${result.detections.length}`);
  console.log(`manifest     ${result.request.redaction_manifest.length}`);

  console.log('\nno raw value survives into the payload:');
  for (const [name, secret] of MUST_NOT_APPEAR) {
    if (payload.includes(secret)) fail(`${name} — "${secret}" IS PRESENT in the payload`);
    else pass(`${name} redacted`);
  }

  console.log('\nstructure the server needs is preserved:');
  for (const [name, needle] of MUST_APPEAR) {
    if (payload.includes(needle)) pass(`${name} kept`);
    else fail(`${name} — "${needle}" was lost to over-redaction`);
  }

  console.log('\nstructural labels are not redacted:');
  const marker = /^\[(?:REDACTED:[A-Z_]+|[A-Z_]+_\d+)\]$/;
  const structural = result.request.dom_summary.filter((n) => /(^|> )(label|dt|th|legend|caption)(:nth-of-type\(\d+\))?$/.test(n.path));
  if (structural.length === 0) fail('no structural label nodes captured — check the fixture');
  for (const node of structural) {
    if (node.value && marker.test(node.value)) fail(`${node.path} — label text replaced with ${node.value}`);
  }
  if (structural.every((n) => !n.value || !marker.test(n.value))) pass(`${structural.length} label/dt node(s) kept their text`);

  console.log('\nmanifest is well-formed:');
  const types = new Set(result.request.redaction_manifest.map((e) => e.type));
  for (const expected of ['password', 'pan', 'bank_account', 'ifsc', 'card_number', 'email', 'phone']) {
    if (types.has(expected)) pass(`${expected} declared`);
    else fail(`${expected} missing from the manifest`);
  }
  const malformed = result.request.redaction_manifest.filter(
    (e) => !e.id || !e.type || ![1, 2].includes(e.tier) || !e.masking || !e.detector,
  );
  if (malformed.length) fail(`${malformed.length} manifest entr(ies) missing required fields`);
  else pass('every entry has id/type/tier/masking/detector');

  console.log(`\ndetected types: ${[...new Set(result.detections.map((d) => d.type))].sort().join(', ')}`);
  console.log(`manifest types: ${[...types].sort().join(', ')}`);
} catch (err) {
  fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  // Chrome flushes profile files as it dies, so a rmdir issued immediately can
  // lose the race. The directory is under the OS temp dir either way.
  await sleep(150);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
