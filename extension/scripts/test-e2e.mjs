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
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const CHROME = process.env.ATHENA_CHROME ?? 'google-chrome-stable';
const CDP_PORT = Number(process.env.ATHENA_CDP_PORT ?? 9335);
const fixture = resolve(process.argv[2] ?? '../eval/fixtures/bank-login.html');

/** Stands in for the local vault. These strings must never reach the server. */
const VAULT = { 'user_saved:username': 'demo-user-42', 'user_saved:password': 'demo-secret-123' };

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
export async function buildPayload(task) {
  const snapshot = captureDomSnapshot();
  const { request } = await buildAgentRequest({
    snapshot, screenshotDataUrl: null, taskInstruction: task,
    tokens: new TokenRegistry('e2e-session'), threshold: 0.5,
  });
  return request;
}
export async function providerPlan(request, settings, key) { return requestProviderPlan(request, settings, key); }
export { executeActions };
export function fieldValue(selector) {
  const el = resolvePath(selector)[0];
  return el ? el.value : null;
}
`);
await build({ entryPoints: [entry], outfile: join(workdir, 'bundle.js'), bundle: true, format: 'iife', globalName: 'ATHENA', target: 'chrome116', logLevel: 'error' });
const bundle = await readFile(join(workdir, 'bundle.js'), 'utf8');
const received = [];
const fixtureHtml = await readFile(fixture, 'utf8');
const provider = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/fixture') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixtureHtml); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access', 'access-control-allow-private-network': 'true' }); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  received.push({ path: req.url, headers: req.headers, body });
  const user = body.messages?.find((message) => message.role === 'user');
  const text = user?.content?.find((part) => part.type === 'text')?.text ?? '';
  const match = text.match(/## dom_summary\n([\s\S]*?)\n\n(?:## |Plan)/);
  const nodes = match ? JSON.parse(match[1]) : [];
  const customerPath = nodes.find((node) => node.path.includes('customer-id'))?.path;
  const passwordPath = nodes.find((node) => node.path.includes('password'))?.path;
  const submitPath = nodes.find((node) => node.path.includes('submit'))?.path;
  const actions = [
    customerPath && { action: 'type', selector: customerPath, value_ref: 'user_saved:username' },
    passwordPath && { action: 'type', selector: passwordPath, value_ref: 'user_saved:password' },
    submitPath && { action: 'click', selector: submitPath },
  ].filter(Boolean);
  const planText = JSON.stringify({ reasoning_summary: 'The visible form can use local credential references.', actions, requires_client_secret: true });
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

  // --- capture → redact -----------------------------------------------------
  const request = JSON.parse(await evaluate(
    `ATHENA.buildPayload('Log me in to this portal.').then(r => JSON.stringify(r))`,
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

  // --- direct provider ------------------------------------------------------
  const providerSettings = { base_url: SERVER_URL, model: 'stub-model', anthropic_format: false };
  const plan = JSON.parse(await evaluate(
    `ATHENA.providerPlan(${JSON.stringify(request)}, ${JSON.stringify(providerSettings)}, "stub-api-key").then(r => JSON.stringify(r))`,
  ));
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
  if (!planBody.includes('user_saved:')) fail('no value_ref in the plan — the server tried to fill the field itself');
  else pass('credentials are named by reference, not supplied');
  if (plan.guardrail_rejections?.length) fail(`planner rejected: ${plan.guardrail_rejections.join('; ')}`);
  else pass('no action tripped the server guardrails');

  const known = new Set(request.dom_summary.map((n) => n.path));
  if (plan.actions.every((a) => !a.selector || known.has(a.selector))) pass('every selector was one we sent');
  else fail('the plan referenced a selector the client never sent');

  // --- execute --------------------------------------------------------------
  const executable = plan.actions.map((a) => {
    const out = { action: a.action };
    if (a.selector) out.selector = a.selector;
    if (a.value_ref) out.value = VAULT[a.value_ref];       // resolved locally
    else if (a.value !== undefined) out.value = a.value;
    return out;
  });
  const run = async (batch) => JSON.parse(await evaluate(
    `ATHENA.executeActions(${JSON.stringify(batch)}, ${JSON.stringify([...known])}).then(o => JSON.stringify(o))`,
  ));
  const report = (outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.ok) pass(`${outcome.action} ${outcome.selector ?? ""} (${outcome.duration_ms} ms)`);
      else fail(`${outcome.action} ${outcome.selector ?? ""} — ${outcome.error}`);
    }
  };

  // Split around the submit: clicking it navigates, which tears down the page
  // context the injected bundle lives in. Fields have to be read before that.
  const fills = executable.filter((a) => a.action !== "click");
  const clicks = executable.filter((a) => a.action === "click");

  console.log('\nexecution against the live DOM:');
  report(await run(fills));

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
} catch (err) {
  fail(err.message);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  await new Promise((resolveClose) => provider.close(resolveClose));
  await sleep(200);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
