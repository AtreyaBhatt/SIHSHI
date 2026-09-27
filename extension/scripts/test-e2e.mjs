/**
 * Scenario A end to end (PRD §10), with no hand-waving between the stages.
 *
 * Starts the real FastAPI server, loads the fixture in real Chrome, runs the real
 * capture → detect → redact pipeline, POSTs the real payload, and executes the
 * plan the server returns against the live DOM. Then it checks the properties
 * that matter:
 *
 *   - the request body carried no secret
 *   - the response carried no secret either, only a value_ref
 *   - the page's password field nevertheless ends up correctly filled
 *
 * That last pair is the whole thesis: the agent completed the task, and the
 * credential never existed anywhere outside this machine.
 *
 * Usage:  npm run test:e2e
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9335);
const fixture = resolve(process.argv[2] ?? '../eval/fixtures/bank-login.html');

/** Stands in for the local vault. These strings must never reach the server. */
const VAULT = { 'user_saved:username': 'demo-user-42', 'user_saved:password': 'demo-secret-123' };
const isBlindfillFixture = /blindfill\.html$/.test(fixture);
const isPortalFixture = /application-portal\.html$/.test(fixture);
// The blindfill/portal fixtures' stored-profile ref. Kept separate from VAULT
// above: VAULT is looped over against every fixture's request/response body,
// and kyc-form.html's own agent-note prose legitimately contains "Rohan Iyer"
// as a documented detector recall gap (README §"the eval will show that as a
// recall gap"), unrelated to this ref ever leaking. The portal fixture's own
// profile card names "Meera Nair" — the same identity the ref stands in for
// there — so the local vault echoes that name instead of blindfill's.
const PROFILE_REFS = isPortalFixture ? { 'user_saved:name': 'Meera Nair' } : { 'user_saved:name': 'Rohan Iyer' };
const RESOLVABLE_REFS = { ...VAULT, ...PROFILE_REFS };

// The portal fixture is the only one that exercises face detection, so only it
// needs the model + demo photo the other scenarios never touch.
const MODEL_PATH = resolve('models/version-RFB-320.onnx');
const FACE_PHOTO_PATH = resolve('../eval/fixtures/assets/faces-2.jpg');
if (isPortalFixture) {
  if (!existsSync(MODEL_PATH)) { console.error('Missing model. Run: npm run fetch:model'); process.exit(1); }
  if (!existsSync(FACE_PHOTO_PATH)) { console.error('Missing test photo. Run: npm run fetch:demo-faces'); process.exit(1); }
}

const workdir = await mkdtemp(join(tmpdir(), 'athena-e2e-'));
let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.error(`  FAIL ${m}`); };

const entry = join(workdir, 'entry.ts');
await writeFile(entry, `
import { captureDomSnapshot } from '${resolve('src/capture/dom-snapshot.ts')}';
import { buildAgentRequest } from '${resolve('src/redaction/build-request.ts')}';
import { TokenRegistry } from '${resolve('src/redaction/tokens.ts')}';
import { executeActions } from '${resolve('src/executor/execute.ts')}';
import { resolvePath } from '${resolve('src/shared/resolve-path.ts')}';
import { requestProviderPlan } from '${resolve('src/background/agent-client.ts')}';
import { detectFaces } from '${resolve('src/perception/face-detect.ts')}';
export const registry = new TokenRegistry('e2e-session');
export async function buildPayload(task, availableRefs = [], priorActions = [], faces = []) {
  const snapshot = captureDomSnapshot();
  const { request, firewall } = await buildAgentRequest({
    snapshot, screenshotDataUrl: null, taskInstruction: task,
    tokens: registry, threshold: 0.5, availableRefs, priorActions, faces,
  });
  // _firewall rides along for the portal harness only; every other caller
  // already ignores unknown fields on the parsed object.
  return { ...request, _firewall: firewall };
}
export async function providerPlan(request, settings, key) { return requestProviderPlan(request, settings, key); }
export { executeActions };
export function fieldValue(selector) {
  const el = resolvePath(selector)[0];
  return el ? el.value : null;
}
export function elementBBox(selector) {
  const el = resolvePath(selector)[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
}
/**
 * Demo stand-in for the offscreen face detector (perception/offscreen.ts):
 * the same device-px/css-px region conversion, run inline against a CDP
 * screenshot instead of via chrome.runtime.
 */
export async function detectFacesInShot(shotDataUrl, viewportWidth, regionsCss) {
  const blob = await (await fetch(shotDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const cssPerDevice = viewportWidth > 0 ? viewportWidth / bitmap.width : 1;
  const devicePerCss = cssPerDevice === 0 ? 1 : 1 / cssPerDevice;
  const regions = regionsCss
    .map((b) => [
      Math.max(0, Math.round(b[0] * devicePerCss)),
      Math.max(0, Math.round(b[1] * devicePerCss)),
      Math.min(bitmap.width, Math.round(b[2] * devicePerCss)),
      Math.min(bitmap.height, Math.round(b[3] * devicePerCss)),
    ])
    .filter((b) => b[2] - b[0] >= 32 && b[3] - b[1] >= 32);
  const result = await detectFaces(bitmap, { modelUrl: '/models/version-RFB-320.onnx', wasmBaseUrl: '/ort/', regions, scale: cssPerDevice });
  bitmap.close();
  return result.faces;
}
/** Stands in for the worker: resolves a value_token via the page-side registry, never the network. */
export function resolveToken(t) { return registry.valueOf(t.slice(1, -1)) ?? null; }
`);
await build({
  entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife',
  globalName: 'ATHENA', target: 'chrome116', logLevel: 'error',
  conditions: ['onnxruntime-web-use-extern-wasm'],
  alias: { 'onnxruntime-web': 'onnxruntime-web/wasm' },
});
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');
const received = [];
const fixtureHtml = await readFile(fixture, 'utf8');
// Static roots the portal fixture's own assets and the face detector's model +
// wasm runtime are served from. Unused (and unreached) by every other fixture.
const STATIC_ROOTS = {
  '/assets/': resolve('../eval/fixtures/assets'),
  '/models/': resolve('models'),
  '/ort/': resolve('node_modules/onnxruntime-web/dist'),
};
const STATIC_MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png' };
const provider = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/fixture') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixtureHtml); return; }
  if (req.method === 'POST' && req.url === '/fixture') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') {
    const prefix = Object.keys(STATIC_ROOTS).find((p) => req.url.startsWith(p));
    if (prefix) {
      try {
        const body = await readFile(join(STATIC_ROOTS[prefix], req.url.slice(prefix.length)));
        res.writeHead(200, { 'content-type': STATIC_MIME[extname(req.url)] ?? 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access', 'access-control-allow-private-network': 'true' }); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  received.push({ path: req.url, headers: req.headers, body });
  const user = body.messages?.find((message) => message.role === 'user');
  const text = user?.content?.find((part) => part.type === 'text')?.text ?? '';
  const match = text.match(/## dom_summary\n([\s\S]*?)\n\n(?:## |<\/page_data>|Plan)/);
  const nodes = match ? JSON.parse(match[1]) : [];
  // redaction_manifest, when present, is always the last section inside the
  // fence, so it is bounded by the closing tag with a single newline, not the
  // double-newline-plus-heading boundary the earlier sections use.
  const manifestMatch = text.match(/## redaction_manifest\n([\s\S]*?)\n<\/page_data>/);
  const manifest = manifestMatch ? JSON.parse(manifestMatch[1]) : [];
  // available_refs sits before the <page_data> fence, not inside it, so its
  // stop boundary is the opening tag rather than the closing one.
  const availableRefsMatch = text.match(/## available_refs\n([\s\S]*?)\n\n(?:## |<page_data>|Plan)/);
  const availableRefs = availableRefsMatch ? JSON.parse(availableRefsMatch[1]) : [];
  const customerPath = nodes.find((node) => node.path.includes('customer-id'))?.path;
  const passwordPath = nodes.find((node) => node.path.includes('password'))?.path;
  const submitPath = nodes.find((node) => node.path.includes('submit'))?.path;
  const blindfillPath = nodes.find((node) => node.path.includes('p-aadhaar'))?.path;
  const portalPath = nodes.find((node) => node.path.includes('pf-aadhaar'))?.path;
  const hasPriorActions = /## prior_actions/.test(text);
  const actions = [
    customerPath && { action: 'type', selector: customerPath, value_ref: 'user_saved:username', risk: 'routine' },
    passwordPath && { action: 'type', selector: passwordPath, value_ref: 'user_saved:password', risk: 'routine' },
    submitPath && { action: 'click', selector: submitPath, risk: 'sensitive' },
  ].filter(Boolean);
  let planText;
  if (portalPath) {
    if (hasPriorActions) {
      // Second request: the form is already filled and Continue was clicked.
      // Recognised by prior_actions rather than re-inspecting the DOM — step 1
      // is hidden by then, so pf-aadhaar (still on the profile card) is all
      // that is left to route on, and it is shared with the first request too.
      planText = JSON.stringify({ reasoning_summary: 'The application was already filled and Continue was clicked; stop here.', actions: [], requires_client_secret: false, done: true, result: 'Application filled; stopped before final submission.' });
    } else {
      const aadhaarToken = manifest.find((e) => e.type === 'aadhaar' && e.dom_path === 'dd#pf-aadhaar')?.id;
      const panToken = manifest.find((e) => e.type === 'pan' && e.dom_path === 'dd#pf-pan')?.id;
      const emailToken = manifest.find((e) => e.type === 'email' && e.dom_path === 'dd#pf-email')?.id;
      const phoneToken = manifest.find((e) => e.type === 'phone' && e.dom_path === 'dd#pf-phone')?.id;
      planText = JSON.stringify({ reasoning_summary: 'Copy the verified profile into the application and choose the department.', actions: [
        { action: 'type', selector: 'input#f-name', value_ref: 'user_saved:name', risk: 'sensitive' },
        aadhaarToken && { action: 'type', selector: 'input#f-aadhaar', value_token: `[${aadhaarToken}]`, risk: 'sensitive' },
        panToken && { action: 'type', selector: 'input#f-pan', value_token: `[${panToken}]`, risk: 'sensitive' },
        emailToken && { action: 'type', selector: 'input#f-email', value_token: `[${emailToken}]`, risk: 'sensitive' },
        phoneToken && { action: 'type', selector: 'input#f-phone', value_token: `[${phoneToken}]`, risk: 'sensitive' },
        { action: 'select', selector: 'select#f-dept', option: 'Computer Science', risk: 'routine' },
        { action: 'click', selector: 'button#f-continue', risk: 'sensitive' },
      ].filter(Boolean), requires_client_secret: true, done: false, result: null });
    }
  } else if (blindfillPath) {
    // BlindFill: available_refs names the vault slot for the ordinary field;
    // the aadhaar/phone fields are filled from the on-page tokens instead.
    void availableRefs;
    const aadhaarToken = manifest.find((e) => e.type === 'aadhaar' && e.dom_path === 'dd#p-aadhaar')?.id;
    const phoneToken = manifest.find((e) => e.type === 'phone' && e.dom_path === 'dd#p-phone')?.id;
    planText = JSON.stringify({ reasoning_summary: 'Copy the verified profile into the form and choose the department.', actions: [
      { action: 'type', selector: 'input#name', value_ref: 'user_saved:name', risk: 'sensitive' },
      aadhaarToken && { action: 'type', selector: 'input#aadhaar', value_token: `[${aadhaarToken}]`, risk: 'sensitive' },
      phoneToken && { action: 'type', selector: 'input#mobile', value_token: `[${phoneToken}]`, risk: 'sensitive' },
      { action: 'select', selector: 'select#dept', option: 'Computer Science', risk: 'routine' },
      { action: 'click', selector: 'button#continue', risk: 'sensitive' },
    ].filter(Boolean), requires_client_secret: true, done: true, result: 'Filled from the verified profile; stopped before submission.' });
  } else if (!passwordPath) {
    // An empty sensitive field is listed in redaction_manifest and sends
    // `null` in dom_summary; select by that plus the label.
    const empty = nodes.filter((n) => n.role === 'textbox' && n.value === null && /\b(pan|otp)\b/i.test(n.label ?? '')).map((n) => (/otp/i.test(n.label) ? 'OTP' : 'PAN'));
    planText = JSON.stringify({ reasoning_summary: 'This is a KYC form; two required fields are empty.', actions: [], requires_client_secret: false, done: true, result: `Required fields still empty: ${[...new Set(empty)].join(', ')}.` });
  } else {
    planText = JSON.stringify({ reasoning_summary: 'The visible form can use local credential references.', actions, requires_client_secret: true, done: false, result: null });
  }
  const payload = req.url === '/messages' ? { content: [{ type: 'text', text: '```json\n' + planText + '\n```' }] } : { choices: [{ message: { content: planText } }] };
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
});
await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
const SERVER_URL = `http://127.0.0.1:${provider.address().port}`;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,800',
  '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${join(workdir, 'profile')}`, `${SERVER_URL}/fixture`,
], { stdio: 'ignore' });

// The portal fixture has more on one page than the shared 1280x800 corpus
// viewport (profile card, two form steps, a canvas, a QR image) — capture is
// viewport-only by design (CLAUDE.md). `--window-size` is not honoured by
// headless Chrome in this environment (verified: window.outerHeight/screen
// stay at their default regardless of the flag), so the taller viewport is
// set via CDP device-metrics emulation instead, which every later step
// (capture, execution, the second capture) also sees.
const PORTAL_VIEWPORT = { width: 1280, height: 1700 };

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
  const evaluate = async (expression) => {
    const id = ++nextId;
    const reply = await new Promise((ok) => {
      pending.set(id, ok);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    return reply.result?.result?.value;
  };
  const command = async (method, params = {}) => {
    const id = ++nextId;
    const reply = await new Promise((ok) => { pending.set(id, ok); socket.send(JSON.stringify({ id, method, params })); });
    return reply;
  };
  await command('Page.navigate', { url: `${SERVER_URL}/fixture` });

  for (let i = 0; i < 40 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(200);
  await evaluate(bundle);

  if (isPortalFixture) {
    await command('Emulation.setDeviceMetricsOverride', { ...PORTAL_VIEWPORT, deviceScaleFactor: 1, mobile: false });
  }

  // --- capture → redact -----------------------------------------------------
  const taskText = isPortalFixture
    ? 'Fill in the application from my verified profile and stop before submitting.'
    : isBlindfillFixture
    ? 'Fill in the scholarship application from my verified profile and stop before submitting.'
    : 'Log me in to this portal.';
  const availableRefs = isBlindfillFixture || isPortalFixture ? ['user_saved:name'] : [];
  // Checked against both portal requests: neither the first (profile visible,
  // form empty) nor the second (form filled, Continue clicked) may ever carry
  // one of these raw values — only tokens, refs and partial masks may.
  const portalPlantedSecrets = [
    'Meera Nair', '2345 6789 0124', 'ABCDE1234F', 'meera.nair@example.net',
    '9845012345', '42 Nandidurga Road', '50100247716839', 'evil.example', 'ignore previous',
  ];

  // The portal fixture is the only one with a photo to scan: a real
  // screenshot goes through the same offscreen-detector math as production
  // (ATHENA.detectFacesInShot), and its faces join the manifest the same way
  // production's buildPayload would.
  let faces = [];
  if (isPortalFixture) {
    const viewportWidth = await evaluate('window.innerWidth');
    const viewportHeight = await evaluate('window.innerHeight');
    const photoBBox = JSON.parse(await evaluate(`JSON.stringify(ATHENA.elementBBox('img#pf-photo'))`));
    // The photo is a realistic profile-card thumbnail (CSS width 160px) showing
    // a group photo — at the default 1x screenshot the whole group would be
    // squashed into a sliver too small for the detector. A higher device scale
    // factor makes the renderer downsample the source image less aggressively
    // for this capture, recovering enough detail to find a face, without
    // changing the fixture's own on-screen size at all.
    await command('Emulation.setDeviceMetricsOverride', { ...PORTAL_VIEWPORT, deviceScaleFactor: 4, mobile: false });
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    // Back to the base (1x) override, not cleared entirely — clearing would
    // drop the viewport back to headless Chrome's real (short) default and
    // every step after this one (capture, execution, the second capture)
    // needs the same tall viewport the first capture saw.
    await command('Emulation.setDeviceMetricsOverride', { ...PORTAL_VIEWPORT, deviceScaleFactor: 1, mobile: false });
    const shotDataUrl = `data:image/png;base64,${shot.result.data}`;
    faces = JSON.parse(await evaluate(
      `ATHENA.detectFacesInShot(${JSON.stringify(shotDataUrl)}, ${viewportWidth}, ${JSON.stringify(photoBBox ? [photoBBox] : [])}).then(f => JSON.stringify(f))`,
    ));
    console.log(`faces        ${faces.length} detected on the profile photo`);
  }

  const request = JSON.parse(await evaluate(
    `ATHENA.buildPayload(${JSON.stringify(taskText)}, ${JSON.stringify(availableRefs)}, [], ${JSON.stringify(faces)}).then(r => JSON.stringify(r))`,
  ));
  const requestBody = JSON.stringify(request);
  console.log(`payload      ${request.dom_summary.length} nodes, ${request.redaction_manifest.length} redactions`);

  console.log('\nthe request carries no secret:');
  for (const [ref, secret] of Object.entries(VAULT)) {
    if (requestBody.includes(secret)) fail(`${ref} value appears in the request body`);
    else pass(`${ref} value absent`);
  }
  if (requestBody.includes('hunter2-not-real')) fail("the page's own password value appears in the request");
  else pass("the page's own password value absent");

  if (isBlindfillFixture) {
    const profileSecrets = ['2345 6789 0124', '9845012345', 'Rohan Iyer'];
    if (profileSecrets.some((s) => requestBody.includes(s))) fail('a raw profile value appears in the request body');
    else pass('profile values absent from the request');

    const aadhaarNode = request.dom_summary.find((n) => n.path === 'dd#p-aadhaar');
    if (aadhaarNode && /^\[AADHAAR_\d+\]$/.test(aadhaarNode.value)) pass('on-page Aadhaar is a numbered token');
    else fail(`on-page Aadhaar was ${JSON.stringify(aadhaarNode?.value)}`);

    if (request.available_refs.includes('user_saved:name')) pass('available_refs carries user_saved:name');
    else fail('available_refs did not include user_saved:name');
  }

  if (isPortalFixture) {
    if (portalPlantedSecrets.some((s) => requestBody.includes(s))) fail('a planted profile value appears in the request body');
    else pass('planted profile values absent from the request');

    if (request.hidden_dropped >= 1) pass(`hidden_dropped is ${request.hidden_dropped} (camouflaged text dropped)`);
    else fail(`hidden_dropped was ${request.hidden_dropped}, expected >= 1`);

    const qrEntry = request.redaction_manifest.find((e) => e.dom_path === 'img#pf-qr');
    if (qrEntry?.type === 'frame' && qrEntry.detector === 'dom:qr') pass('QR image declared as a frame (dom:qr)');
    else fail(`QR image manifest entry was ${JSON.stringify(qrEntry)}`);

    const canvasEntry = request.redaction_manifest.find((e) => e.dom_path === 'canvas#pf-canvas');
    if (canvasEntry?.type === 'frame') pass('canvas region declared as a frame');
    else fail(`canvas manifest entry was ${JSON.stringify(canvasEntry)}`);

    const faceEntry = request.redaction_manifest.find((e) => e.type === 'face');
    if (faceEntry) pass('a face was declared in the manifest');
    else fail('no face entry in the manifest');

    if (request._firewall.masked === 0 && request._firewall.blocked === 0) pass('firewall report is masked 0, blocked 0');
    else fail(`firewall report was masked ${request._firewall.masked}, blocked ${request._firewall.blocked}`);

    if (request.available_refs.includes('user_saved:name')) pass('available_refs carries user_saved:name');
    else fail('available_refs did not include user_saved:name');
  }

  // --- direct provider ------------------------------------------------------
  const providerSettings = { base_url: SERVER_URL, model: 'stub-model', anthropic_format: false };
  const plan = JSON.parse(await evaluate(
    `ATHENA.providerPlan(${JSON.stringify(request)}, ${JSON.stringify(providerSettings)}, "stub-api-key").then(r => JSON.stringify(r))`,
  ));
  if (plan.done && plan.actions.length === 0) {
    console.log('\nScenario C — the model answered without acting:');
    if (/PAN/.test(plan.result) && /OTP/.test(plan.result)) pass(`result names the empty fields: ${plan.result}`); else fail(`result did not name PAN and OTP: ${plan.result}`);
    if (plan.actions.length === 0) pass('nothing was executed');
    throw { skip: true };
  }
  const anthropicPlan = JSON.parse(await evaluate(
    `ATHENA.providerPlan(${JSON.stringify(request)}, ${JSON.stringify({ ...providerSettings, anthropic_format: true })}, "stub-api-key").then(r => JSON.stringify(r))`,
  ));
  const planBody = JSON.stringify(plan);
  console.log(`\nplan         ${plan.actions.length} actions, requires_client_secret=${plan.requires_client_secret}`);
  if (anthropicPlan.actions.length === plan.actions.length) pass('OpenAI and Anthropic provider formats parsed');
  else fail('Anthropic provider response was not parsed');
  if (received.some((call) => call.path === '/chat/completions' && call.headers.authorization === 'Bearer stub-api-key')) pass('OpenAI provider request used Bearer auth');
  else fail('OpenAI provider request was malformed');
  if (received.some((call) => call.path === '/messages' && call.headers['x-api-key'] === 'stub-api-key')) pass('Anthropic provider request used x-api-key auth');
  else fail('Anthropic provider request was malformed');

  console.log('\nthe response carries no secret, only references:');
  for (const [, secret] of Object.entries(VAULT)) {
    if (planBody.includes(secret)) fail('a vault value came back from the server');
  }
  if (isBlindfillFixture && planBody.includes('Rohan Iyer')) fail('the stored profile name came back from the server');
  if (isPortalFixture && planBody.includes('Meera Nair')) fail('the stored profile name came back from the server');
  if (!planBody.includes('user_saved:')) fail('no value_ref in the plan — the server tried to fill the field itself');
  else pass('credentials are named by reference, not supplied');
  if (plan.guardrail_rejections?.length) fail(`planner rejected: ${plan.guardrail_rejections.join('; ')}`);
  else pass('no action tripped the server guardrails');

  const known = new Set(request.dom_summary.map((n) => n.path));
  if (plan.actions.every((a) => !a.selector || known.has(a.selector))) pass('every selector was one we sent');
  else fail('the plan referenced a selector the client never sent');

  // --- execute --------------------------------------------------------------
  // value_token is resolved here via ATHENA.resolveToken, standing in for the
  // worker: the plan never carries the value itself, only the opaque token.
  const executable = [];
  for (const a of plan.actions) {
    const out = { action: a.action };
    if (a.selector) out.selector = a.selector;
    if (a.value_ref) out.value = RESOLVABLE_REFS[a.value_ref]; // resolved locally
    else if (a.value_token) out.value = await evaluate(`ATHENA.resolveToken(${JSON.stringify(a.value_token)})`);
    else if (a.value !== undefined) out.value = a.value;
    if (a.option) out.option = a.option;
    executable.push(out);
  }
  const run = async (batch) => JSON.parse(await evaluate(
    `ATHENA.executeActions(${JSON.stringify(batch)}, ${JSON.stringify([...known])}).then(o => JSON.stringify(o))`,
  ));
  const report = (outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.ok) pass(`${outcome.action} ${outcome.selector ?? ""} (${outcome.duration_ms} ms)`);
      else fail(`${outcome.action} ${outcome.selector ?? ""} — ${outcome.error}`);
    }
  };

  // Split around the submit/continue click: clicking submit navigates, which
  // tears down the page context the injected bundle lives in. Fields have to
  // be read before that either way.
  const fills = executable.filter((a) => a.action !== "click");
  const clicks = executable.filter((a) => a.action === "click");

  console.log('\nexecution against the live DOM:');
  report(await run(fills));

  if (isPortalFixture) {
    console.log('\nplan resolves tokens and refs, never a literal secret:');
    if (plan.actions.some((a) => a.value_token)) pass('plan contains a value_token');
    else fail('plan did not contain a value_token');
    if (plan.requires_client_secret === true) pass('requires_client_secret is true');
    else fail('requires_client_secret was not true');

    console.log('\nthe fields were actually filled from the verified profile:');
    const typedName = await evaluate(`ATHENA.fieldValue('input#f-name')`);
    const typedAadhaar = await evaluate(`ATHENA.fieldValue('input#f-aadhaar')`);
    const typedPan = await evaluate(`ATHENA.fieldValue('input#f-pan')`);
    const typedEmail = await evaluate(`ATHENA.fieldValue('input#f-email')`);
    const typedPhone = await evaluate(`ATHENA.fieldValue('input#f-phone')`);
    const selectedDept = await evaluate(`ATHENA.fieldValue('select#f-dept')`);
    if (typedName === 'Meera Nair') pass('name field holds the vault-resolved value');
    else fail(`name field holds ${JSON.stringify(typedName)}`);
    if (typedAadhaar === '2345 6789 0124') pass('aadhaar field holds the token-resolved value');
    else fail(`aadhaar field holds ${JSON.stringify(typedAadhaar)}`);
    if (typedPan === 'ABCDE1234F') pass('PAN field holds the token-resolved value');
    else fail(`PAN field holds ${JSON.stringify(typedPan)}`);
    if (typedEmail === 'meera.nair@example.net') pass('email field holds the token-resolved value');
    else fail(`email field holds ${JSON.stringify(typedEmail)}`);
    if (typedPhone === '9845012345') pass('phone field holds the token-resolved value');
    else fail(`phone field holds ${JSON.stringify(typedPhone)}`);
    if (selectedDept === 'cs') pass('department select holds cs');
    else fail(`department select holds ${JSON.stringify(selectedDept)}`);

    if (clicks.length > 0) report(await run(clicks));

    console.log('\nsecond request — the model is told what already happened:');
    const priorActions = plan.actions.map((a) => ({ ...a, outcome: 'ok' }));
    const request2 = JSON.parse(await evaluate(
      `ATHENA.buildPayload(${JSON.stringify(taskText)}, ${JSON.stringify(availableRefs)}, ${JSON.stringify(priorActions)}, []).then(r => JSON.stringify(r))`,
    ));
    const request2Body = JSON.stringify(request2);
    for (const [ref, secret] of Object.entries(VAULT)) {
      if (request2Body.includes(secret)) fail(`${ref} value appears in the second request body`);
    }
    if (portalPlantedSecrets.some((s) => request2Body.includes(s))) fail('a planted profile value appears in the second request body');
    else pass('planted profile values absent from the second request');
    const plan2 = JSON.parse(await evaluate(
      `ATHENA.providerPlan(${JSON.stringify(request2)}, ${JSON.stringify(providerSettings)}, "stub-api-key").then(r => JSON.stringify(r))`,
    ));
    if (plan2.done === true) pass('second plan is done');
    else fail('second plan was not done');
    if (plan2.actions.length === 0) pass('second plan carries no actions');
    else fail(`second plan carried ${plan2.actions.length} action(s)`);
    if (plan2.result === 'Application filled; stopped before final submission.') pass('second plan result matches');
    else fail(`second plan result was ${JSON.stringify(plan2.result)}`);

    const out = await evaluate(`document.getElementById('out').textContent`);
    if (out === '') pass('the application was never submitted (#out is empty)');
    else fail(`#out was ${JSON.stringify(out)} — the form was submitted`);
  } else if (isBlindfillFixture) {
    console.log('\nplan resolves tokens and refs, never a literal secret:');
    if (plan.actions.some((a) => a.value_token)) pass('plan contains a value_token');
    else fail('plan did not contain a value_token');
    if (plan.requires_client_secret === true) pass('requires_client_secret is true');
    else fail('requires_client_secret was not true');

    console.log('\nthe fields were actually filled from the verified profile:');
    const typedName = await evaluate(`ATHENA.fieldValue('input#name')`);
    const typedAadhaar = await evaluate(`ATHENA.fieldValue('input#aadhaar')`);
    const typedMobile = await evaluate(`ATHENA.fieldValue('input#mobile')`);
    const selectedDept = await evaluate(`ATHENA.fieldValue('select#dept')`);
    if (typedName === 'Rohan Iyer') pass('name field holds the vault-resolved value');
    else fail(`name field holds ${JSON.stringify(typedName)}`);
    if (typedAadhaar === '2345 6789 0124') pass('aadhaar field holds the token-resolved value');
    else fail(`aadhaar field holds ${JSON.stringify(typedAadhaar)}`);
    if (typedMobile === '9845012345') pass('mobile field holds the token-resolved value');
    else fail(`mobile field holds ${JSON.stringify(typedMobile)}`);
    if (selectedDept === 'cs') pass('department select holds cs');
    else fail(`department select holds ${JSON.stringify(selectedDept)}`);

    if (clicks.length > 0) {
      report(await run(clicks));
      const out = await evaluate(`document.getElementById('out').textContent`);
      if (out === '') pass('Continue did not submit the form (#out is empty)');
      else fail(`#out was ${JSON.stringify(out)} — the form was submitted`);
    }
  } else {
    console.log('\nthe fields were actually filled:');
    const typedPassword = await evaluate(`ATHENA.fieldValue('input#password')`);
    const typedUsername = await evaluate(`ATHENA.fieldValue('input#customer-id')`);
    if (typedPassword === VAULT['user_saved:password']) pass('password field holds the locally-resolved credential');
    else fail(`password field holds ${JSON.stringify(typedPassword)}`);
    if (typedUsername === VAULT['user_saved:username']) pass('username field holds the locally-resolved credential');
    else fail(`username field holds ${JSON.stringify(typedUsername)}`);

    if (clicks.length > 0) {
      const before = await evaluate('location.href');
      report(await run(clicks));
      await sleep(400);
      const after = await evaluate('location.href');
      if (after !== before) pass(`form submitted — page navigated to ${after.split('/').pop()}`);
      else pass('click dispatched (fixture did not navigate)');
    }
  }
} catch (err) {
  if (err?.skip) {} else fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await new Promise((resolveClose) => provider.close(resolveClose));
  await sleep(200);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
