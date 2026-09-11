/**
 * Renders demo/athena-demo.html to an mp4 without touching the desktop.
 *
 * Headless Chromium runs the page on a virtual clock: each frame advances time by
 * exactly 1/FPS s and takes a screenshot, so animations are smooth and the result
 * is identical on every run. ffmpeg then encodes the frames.
 *
 * Usage: node demo/render.mjs [out.mp4]   (needs chromium + ffmpeg on PATH)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FPS = 30, MAX_SECONDS = 60, W = 1600, H = 1000, PORT = 9444;
const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(resolve(here, 'athena-demo.html')).href;
const out = resolve(process.argv[2] ?? join(here, 'athena-demo.mp4'));
const work = await mkdtemp(join(tmpdir(), 'athena-render-'));

const chrome = spawn(process.env.CHROME ?? 'chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
  `--user-data-dir=${join(work, 'profile')}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { await sleep(250); }
}
if (!target) throw new Error('chromium did not come up');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); const waiters = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  else if (waiters.has(m.method)) { waiters.get(m.method)(m); waiters.delete(m.method); }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const once = (method) => new Promise((r) => waiters.set(method, r));

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: page + '?autoplay' });
  await loaded;
  // ponytail: real-time capture. Screenshots are taken as fast as headless allows and
  // encoded at the measured rate, so timing matches the page's own clock.
  const t0 = Date.now(); let n = 0;
  for (; n < FPS * MAX_SECONDS; n++) {
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    if (shot.error) { console.error(shot.error.message); continue; }
    await writeFile(join(work, `f${String(n).padStart(5, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'));
    if (n % 20 === 0) {
      const done = await send('Runtime.evaluate', { expression: 'window.__done === true', returnByValue: true });
      process.stdout.write(`\r${((Date.now() - t0) / 1000).toFixed(0)}s`);
      if (done.result?.result?.value) { n++; break; }
    }
  }
  const fps = n / ((Date.now() - t0) / 1000);
  console.log(`\n${n} frames at ${fps.toFixed(1)} fps → ${out}`);
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps.toFixed(3), '-i', join(work, 'f%05d.jpg'),
    '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' });
  if (ff.status !== 0) throw new Error('ffmpeg failed');
} finally {
  ws.close(); chrome.kill();
  await rm(work, { recursive: true, force: true });
}
