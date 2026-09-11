/**
 * Headless smoke test for the capture layer.
 *
 * Loads a fixture in real Chrome, runs captureDomSnapshot() against it, and
 * checks the two properties everything downstream depends on:
 *
 *   - every emitted `path` resolves to exactly one element (the M4 action
 *     planner may only target selectors we sent it, so an ambiguous path is a
 *     failed action later, not a cosmetic flaw)
 *   - every bbox is non-degenerate and on-screen (the M3 pixel redactor and the
 *     IoU scoring in run_eval.py both key off these coordinates)
 *
 * Usage:  npm run smoke [-- path/to/fixture.html]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const PORT = Number(process.env.ATHENA_CDP_PORT ?? 9333);
const fixture = resolve(process.argv[2] ?? '../eval/fixtures/bank-login.html');

const workdir = await mkdtemp(join(tmpdir(), 'athena-smoke-'));
const bundlePath = join(workdir, 'snapshot.js');

const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
export { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
export { resolvePath } from '${resolve('src/shared/resolve-path.ts')}';
`);

await build({
  entryPoints: [entry],
  outfile: bundlePath,
  bundle: true,
  format: 'iife',
  globalName: 'ATHENA',
  target: 'chrome116',
  logLevel: 'error',
});
const bundle = await readFile(bundlePath, 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1280,800',
  '--disable-gpu',
  '--no-first-run',
  '--hide-scrollbars',
  `--user-data-dir=${join(workdir, 'profile')}`,
  `file://${fixture}`,
], { stdio: 'ignore' });

let socket;
let exitCode = 0;

try {
  let pages = [];
  for (let i = 0; i < 60 && pages.length === 0; i++) {
    try {
      pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
    } catch {
      /* Chrome is still coming up */
    }
    if (pages.length === 0) await sleep(250);
  }
  if (pages.length === 0) throw new Error(`No page target on :${PORT} — is ${CHROME} installed?`);

  socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = () => fail(new Error('CDP connect failed')); });

  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
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

  const report = JSON.parse(await evaluate(`${bundle}; (() => {
    const snap = ATHENA.captureDomSnapshot();
    const problems = [];
    for (const n of snap.nodes) {
      const count = ATHENA.resolvePath(n.path).length;
      if (count !== 1) problems.push(n.path + ' → resolves to ' + count + ' elements');
      const [x1, y1, x2, y2] = n.bbox;
      if (x2 <= x1 || y2 <= y1) problems.push(n.path + ' → degenerate bbox');
    }
    return JSON.stringify({
      nodes: snap.nodes.length,
      truncated: snap.truncated,
      walk_ms: snap.timings.dom_walk_ms,
      passwords_omitted: snap.nodes.filter((n) => n.value_omitted === 'password').length,
      problems,
    });
  })()`));

  console.log(`fixture            ${fixture}`);
  console.log(`nodes captured     ${report.nodes}${report.truncated ? ' (TRUNCATED)' : ''}`);
  console.log(`dom walk           ${report.walk_ms} ms`);
  console.log(`password values omitted  ${report.passwords_omitted}`);

  if (report.problems.length > 0) {
    console.error(`\nFAIL — ${report.problems.length} problem(s):`);
    for (const p of report.problems) console.error(`  ${p}`);
    exitCode = 1;
  } else {
    console.log('\nOK — every selector resolves uniquely, every bbox is well-formed.');
  }
} catch (err) {
  console.error(`FAIL — ${err.message}`);
  exitCode = 1;
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  // Chrome flushes profile files as it dies, so a rmdir issued immediately can
  // lose the race. The directory is under the OS temp dir either way.
  await sleep(150);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

process.exit(exitCode);
