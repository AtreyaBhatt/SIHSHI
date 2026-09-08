/**
 * The privacy property, checked in real Chrome against every fixture.
 *
 * For each fixture: capture, run the detector cascade, build the §7.1 payload,
 * then grep the serialized payload for every value planted in the page. One hit
 * is a leak and fails the run.
 *
 * The complementary failure is over-redaction — it costs precision points and
 * breaks the agent's ability to do the task — so the structural strings the
 * server needs are asserted present in the same pass.
 *
 * Known recall gaps are reported, not failed. See fixtures.spec.mjs.
 *
 * Usage:  npm run test:redaction [-- <fixture name fragment>]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { FIXTURES } from './fixtures.spec.mjs';

const CHROME = process.env.PPVA_CHROME ?? 'google-chrome-stable';
const PORT = Number(process.env.PPVA_CDP_PORT ?? 9334);

const only = process.argv[2];
const specs = FIXTURES.filter((f) => !only || f.file.includes(only) || f.name.includes(only));
if (specs.length === 0) {
  console.error(`No fixture matches ${only}`);
  process.exit(1);
}

const workdir = await mkdtemp(join(tmpdir(), 'ppva-redaction-'));
const entry = join(workdir, 'entry.ts');

await writeFile(entry, `
import { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
import { buildAgentRequest } from '${resolve('src/redaction/build-request.ts')}';
import { TokenRegistry } from '${resolve('src/redaction/tokens.ts')}';
export async function run(threshold) {
  const snapshot = captureDomSnapshot();
  const { request, detections } = await buildAgentRequest({
    snapshot, screenshotDataUrl: null, taskInstruction: 'Complete this form.',
    tokens: new TokenRegistry('test-session'), threshold,
  });
  return { request, detections, nodes: snapshot.nodes.length };
}
`);
await build({ entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife', globalName: 'PPVA', target: 'chrome116', logLevel: 'error' });
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1280,800',
  '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${join(workdir, 'profile')}`, 'about:blank',
], { stdio: 'ignore' });

let socket;
let failures = 0;
let gapsClosed = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };
const gap = (m) => console.log(`  gap  ${m}`);

const MARKER = /^\[(?:REDACTED:[A-Z_]+|[A-Z_]+_\d+)\]$/;
const STRUCTURAL_PATH = /(^|> )(label|dt|th|legend|caption)(:nth-of-type\(\d+\))?$/;

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
  const call = (method, params) => {
    const id = ++nextId;
    return new Promise((ok) => {
      pending.set(id, ok);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };

  for (const spec of specs) {
    const fixture = resolve(spec.file);
    console.log(`\n=== ${spec.name} ===`);
    console.log(`${fixture}`);

    await call('Page.navigate', { url: `file://${fixture}` });
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if ((await evaluate('document.readyState')) === 'complete' && (await evaluate('location.protocol')) === 'file:') break;
    }
    await evaluate(bundle);

    const result = JSON.parse(await evaluate(`PPVA.run(0.5).then(r => JSON.stringify(r))`));
    const payload = JSON.stringify(result.request);
    console.log(`nodes ${result.nodes} · detections ${result.detections.length} · manifest ${result.request.redaction_manifest.length}`);

    if (process.env.PPVA_EMIT_PAYLOAD && spec === specs[0]) {
      await writeFile(process.env.PPVA_EMIT_PAYLOAD, JSON.stringify(result.request, null, 2));
      console.log(`emitted payload -> ${process.env.PPVA_EMIT_PAYLOAD}`);
    }

    console.log('\nno raw value survives into the payload:');
    for (const [name, secret] of spec.mustNotAppear) {
      if (payload.includes(secret)) fail(`${name} — "${secret}" IS PRESENT in the payload`);
      else pass(`${name} redacted`);
    }

    console.log('\nstructure the server needs is preserved:');
    for (const [name, needle] of spec.mustAppear) {
      if (payload.includes(needle)) pass(`${name} kept`);
      else fail(`${name} — "${needle}" was lost to over-redaction`);
    }

    if (spec.redactedFields?.length) {
      console.log('\nspecific fields carry a redaction marker:');
      const byPath = new Map(result.request.dom_summary.map((n) => [n.path, n]));
      for (const [name, selector] of spec.redactedFields) {
        const node = byPath.get(selector);
        if (!node) fail(`${name} — ${selector} was not captured at all`);
        else if (!node.value || !MARKER.test(node.value)) fail(`${name} — ${selector} sent ${JSON.stringify(node.value)}`);
        else pass(`${name} → ${node.value}`);
      }
    }

    console.log('\nstructural labels are not redacted:');
    const structural = result.request.dom_summary.filter((n) => STRUCTURAL_PATH.test(n.path));
    const clobbered = structural.filter((n) => n.value && MARKER.test(n.value));
    for (const node of clobbered) fail(`${node.path} — label text replaced with ${node.value}`);
    if (clobbered.length === 0) pass(`${structural.length} label/dt/th node(s) kept their text`);

    console.log('\nmanifest is well-formed:');
    const types = new Set(result.request.redaction_manifest.map((e) => e.type));
    for (const expected of spec.manifestTypes) {
      if (types.has(expected)) pass(`${expected} declared`);
      else fail(`${expected} missing from the manifest`);
    }
    const malformed = result.request.redaction_manifest.filter(
      (e) => !e.id || !e.type || ![1, 2].includes(e.tier) || !e.masking || !e.detector,
    );
    if (malformed.length) fail(`${malformed.length} manifest entr(ies) missing required fields`);
    else pass('every entry has id/type/tier/masking/detector');

    if (spec.knownGaps?.length) {
      console.log('\nknown recall gaps (reported, not failed):');
      for (const [name, value, why] of spec.knownGaps) {
        if (payload.includes(value)) gap(`${name} still passes through — ${why}`);
        else { gapsClosed++; console.log(`  NEW  ${name} is now caught — update fixtures.spec.mjs`); }
      }
    }
  }
} catch (err) {
  fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await sleep(150);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log(
  failures === 0
    ? `\nPASS${gapsClosed ? ` (${gapsClosed} known gap(s) now closed — update the spec)` : ''}`
    : `\nFAIL — ${failures} problem(s)`,
);
process.exit(failures === 0 ? 0 : 1);
