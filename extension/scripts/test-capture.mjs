/**
 * Any-site capture: shadow DOM and iframes.
 *
 * Loads eval/fixtures/shadow-iframe.html in real Chrome and checks:
 *   - a node inside the open shadow root is captured, with a ` >>> ` path
 *   - every emitted path resolves to exactly one element via resolvePath
 *   - the iframe is captured as media 'iframe' and declared in the manifest
 *     as a Tier-1 `frame` entry
 *   - the redacted screenshot is black over the iframe (the card number the
 *     walk cannot see is nonetheless gone)
 *   - the email inside the shadow root does not survive into the payload
 *
 * Usage:  npm run test:capture
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const PORT = Number(process.env.ATHENA_CDP_PORT ?? 9344);
const fixture = resolve('../eval/fixtures/shadow-iframe.html');

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };

const workdir = await mkdtemp(join(tmpdir(), 'athena-capture-'));
const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
import { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
import { resolvePath } from '${resolve('src/shared/resolve-path.ts')}';
import { buildAgentRequest } from '${resolve('src/redaction/build-request.ts')}';
import { TokenRegistry } from '${resolve('src/redaction/tokens.ts')}';

export async function run(shotDataUrl) {
  const snapshot = captureDomSnapshot();
  const resolution = snapshot.nodes.map((n) => ({ path: n.path, count: resolvePath(n.path).length }));
  const { request } = await buildAgentRequest({
    snapshot, screenshotDataUrl: shotDataUrl, taskInstruction: 'Continue checkout.',
    tokens: new TokenRegistry('capture-test'), threshold: 0.5,
  });

  // Sample the redacted PNG at the centre of the iframe's box.
  const frame = snapshot.nodes.find((n) => n.path === 'iframe#payment');
  let centre = null;
  if (frame && request.screenshot_redacted) {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/png;base64,' + request.screenshot_redacted; });
    const scale = img.width / snapshot.viewport.width;
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const [x1, y1, x2, y2] = frame.bbox;
    const px = ctx.getImageData(Math.round(((x1 + x2) / 2) * scale), Math.round(((y1 + y2) / 2) * scale), 1, 1).data;
    centre = [px[0], px[1], px[2]];
  }
  return { nodes: snapshot.nodes, resolution, request, centre, truncated: snapshot.truncated };
}
`);
await build({ entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife', globalName: 'ATHENA', target: 'chrome116', logLevel: 'error' });
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1280,800',
  '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${join(workdir, 'profile')}`, `file://${fixture}`,
], { stdio: 'ignore' });

let socket;
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
  socket.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call = (method, params) => { const id = ++nextId; return new Promise((ok) => { pending.set(id, ok); socket.send(JSON.stringify({ id, method, params })); }); };
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails, null, 2));
    return r.result?.result?.value;
  };

  for (let i = 0; i < 40 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);
  await sleep(400); // let the srcdoc frame paint
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await evaluate(bundle);
  const r = JSON.parse(await evaluate(`ATHENA.run(${JSON.stringify(`data:image/png;base64,${shot.result.data}`)}).then((x) => JSON.stringify(x))`));
  const byPath = new Map(r.nodes.map((n) => [n.path, n]));
  console.log(`nodes ${r.nodes.length} · manifest ${r.request.redaction_manifest.length}`);

  console.log('\nshadow DOM:');
  const inner = byPath.get('div#widget >>> input#inner-email');
  if (inner) pass('input inside the open shadow root captured as div#widget >>> input#inner-email');
  else fail(`shadow input not captured; paths seen: ${[...byPath.keys()].filter((p) => p.includes('inner')).join(', ') || 'none'}`);
  const bad = r.resolution.filter((x) => x.count !== 1);
  if (bad.length === 0) pass(`all ${r.resolution.length} paths resolve to exactly one element`);
  else fail(`${bad.length} path(s) do not resolve uniquely: ${bad.map((b) => `${b.path} → ${b.count}`).join('; ')}`);
  const payload = JSON.stringify(r.request);
  if (payload.includes('grace.hopper@example.org')) fail('raw email inside the shadow root is in the payload');
  else pass('email inside the shadow root redacted');
  if (payload.includes('Grace Hopper')) fail('raw name inside the shadow root is in the payload');
  else pass('name inside the shadow root redacted');
  if (payload.includes('Continue')) pass('shadow button label kept');
  else fail('shadow button label lost');

  console.log('\niframe:');
  const frame = byPath.get('iframe#payment');
  if (frame?.media === 'iframe' && frame.role === 'frame') pass("iframe captured with media 'iframe' and role 'frame'");
  else fail(`iframe node: ${JSON.stringify(frame)}`);
  const entry = r.request.redaction_manifest.find((e) => e.type === 'frame' && e.dom_path === 'iframe#payment');
  if (entry?.tier === 1 && entry.masking === 'blackbox') pass('manifest declares the frame as a Tier-1 blackbox region');
  else fail(`no frame manifest entry: ${JSON.stringify(r.request.redaction_manifest.map((e) => e.type))}`);
  if (r.centre && r.centre.every((v) => v < 16)) pass(`iframe pixels are black in the redacted screenshot (${r.centre.join(',')})`);
  else fail(`iframe centre pixel is ${JSON.stringify(r.centre)} — the card number inside the frame is visible`);
  if (payload.includes('4539')) fail('card number from inside the iframe is in the payload text');
  else pass('nothing from inside the iframe is in the payload text');
} catch (err) {
  fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await sleep(150);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
