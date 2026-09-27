/**
 * Every page verb against a real DOM in headless Chrome. No provider, no
 * network: actions are hand-written, the allowlist is the fixture's own paths.
 *
 * Usage: npm run test:executor
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9337);
const fixtureHtml = await readFile(resolve('../eval/fixtures/controls.html'), 'utf8');
const workdir = await mkdtemp(join(tmpdir(), 'athena-exec-'));
let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };

const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
import { executeActions } from '${resolve('src/executor/execute.ts')}';
export { executeActions };
`);
await build({ entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife', globalName: 'ATHENA', target: 'chrome116', logLevel: 'error' });
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixtureHtml); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const URL_ = `http://127.0.0.1:${server.address().port}/controls`;

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,800', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${join(workdir, 'profile')}`, URL_], { stdio: 'ignore' });
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
  let nextId = 0; const pending = new Map();
  socket.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = async (expression) => {
    const id = ++nextId;
    const reply = await new Promise((ok) => { pending.set(id, ok); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };
  for (let i = 0; i < 40 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);
  await evaluate(bundle);

  const allowed = ['input#q', 'select#country', 'input#a', 'input#b', 'button#go', 'div#menu', 'button#signout', 'button#bottom'];
  const run = async (actions, origin) => JSON.parse(await evaluate(`ATHENA.executeActions(${JSON.stringify(actions)}, ${JSON.stringify(allowed)}, ${JSON.stringify(origin ?? null)}).then((o) => JSON.stringify(o))`));
  const out = () => evaluate(`document.getElementById('out').textContent`);
  const okAll = (outcomes, label) => { const bad = outcomes.filter((o) => !o.ok); if (bad.length) fail(`${label}: ${bad.map((o) => `${o.action} ${o.error}`).join('; ')}`); else pass(label); };

  okAll(await run([{ action: 'type', selector: 'input#q', value: 'new value' }]), 'type');
  if ((await evaluate(`document.getElementById('q').value`)) === 'new value') pass('type replaces the existing value'); else fail('type did not replace the existing value');

  okAll(await run([{ action: 'select', selector: 'select#country', option: 'india' }]), 'select by label, case-insensitive');
  if ((await out()) === 'country:in') pass('select fired change'); else fail(`select: out=${await out()}`);
  okAll(await run([{ action: 'select', selector: 'select#country', option: 'gb' }]), 'select by value');
  if ((await evaluate(`document.getElementById('country').value`)) === 'gb') pass('select by value took'); else fail('select by value did not take');
  const missing = await run([{ action: 'select', selector: 'select#country', option: 'Atlantis' }]);
  if (!missing[0].ok && /Atlantis/.test(missing[0].error)) pass('select unknown option fails with the option named'); else fail('select unknown option did not fail cleanly');

  okAll(await run([{ action: 'key', selector: 'input#q', key: 'Escape' }]), 'key Escape on a target');
  if ((await out()) === 'escaped') pass('keydown reached the page listener'); else fail(`key: out=${await out()}`);
  okAll(await run([{ action: 'key', selector: 'input#q', key: 'Enter' }]), 'key Enter in a form');
  if ((await out()) === 'submitted:new value') pass('Enter submitted the form via requestSubmit'); else fail(`Enter: out=${await out()}`);
  okAll(await run([{ action: 'click', selector: 'input#a' }, { action: 'key', key: 'Tab' }]), 'key Tab with no selector');
  if ((await evaluate(`document.activeElement.id`)) === 'b') pass('Tab moved focus to the next focusable'); else fail(`Tab: active=${await evaluate('document.activeElement.id')}`);

  okAll(await run([{ action: 'hover', selector: 'div#menu' }]), 'hover');
  if ((await evaluate(`getComputedStyle(document.getElementById('sub')).display`)) === 'block') pass('hover revealed the submenu'); else fail('hover did not reveal the submenu');

  await evaluate('window.scrollTo(0, 0)');
  okAll(await run([{ action: 'scroll' }]), 'scroll default down');
  const y1 = await evaluate('window.scrollY');
  if (y1 > 0) pass(`scroll moved down ${y1}px`); else fail('scroll down did nothing');
  okAll(await run([{ action: 'scroll', direction: 'up' }]), 'scroll up');
  if ((await evaluate('window.scrollY')) < y1) pass('scroll up moved back'); else fail('scroll up did nothing');
  okAll(await run([{ action: 'scroll', selector: 'button#bottom' }]), 'scroll to selector');
  if ((await evaluate('window.scrollY')) > y1) pass('scroll to selector reached the bottom'); else fail('scroll to selector did not move');

  okAll(await run([{ action: 'wait' }]), 'wait');

  const denied = await run([{ action: 'scroll', selector: 'p#out' }]);
  if (!denied[0].ok && /not in the snapshot/.test(denied[0].error)) pass('scroll with an unlisted selector is refused'); else fail('scroll skipped the allowlist');
  const hoverDenied = await run([{ action: 'hover', selector: 'h1' }]);
  if (!hoverDenied[0].ok) pass('hover with an unlisted selector is refused'); else fail('hover skipped the allowlist');

  const wrongOrigin = await run([{ action: 'click', selector: 'button#go' }], 'https://elsewhere.example');
  if (!wrongOrigin[0].ok && /origin/.test(wrongOrigin[0].error)) pass('action refused when the page origin is not the expected one'); else fail('origin check missing');
  const rightOrigin = await run([{ action: 'wait' }], new URL(URL_).origin);
  if (rightOrigin[0].ok) pass('action allowed on the expected origin'); else fail('origin check false positive');

  const secret = await run([{ action: 'type', selector: 'select#country', value: 'top-secret-value' }]);
  if (!secret[0].ok && !secret[0].error.includes('top-secret-value')) pass('a failed type never echoes its value'); else fail('type error leaked the value or succeeded on a select');
} catch (err) {
  fail(err.message);
} finally {
  socket?.close(); chrome.kill('SIGKILL');
  await new Promise((ok) => server.close(ok));
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
