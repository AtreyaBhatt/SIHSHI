/**
 * Guardrail and wire-shape tests, Node only (no browser, no network).
 * Bundles direct-provider-response.ts with esbuild and asserts what a
 * provider's raw JSON becomes after parsing and constraint.
 *
 * Usage: npm run test:reasoning
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-reasoning-'));
await build({ entryPoints: ['src/background/direct-provider-response.ts'], outfile: join(temp, 'dpr.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
const { normalizeProviderResponse } = await import(`file://${join(temp, 'dpr.mjs')}`);

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.error(`  FAIL ${msg}`); } };

const request = {
  session_id: 's1', task_instruction: 'Log in', screenshot_redacted: null,
  dom_summary: [
    { path: 'input#user', role: 'textbox', label: 'Customer id', value: null },
    { path: 'input#password', role: 'textbox', label: 'Password', value: '[REDACTED:PASSWORD]' },
    { path: 'select#country', role: 'combobox', label: 'Country', value: null },
    { path: 'button#go', role: 'button', label: 'Sign in', value: null },
  ],
  redaction_manifest: [{ id: 'PASSWORD_1', type: 'password', tier: 1, bbox: null, dom_path: 'input#password', masking: 'blackbox', detector: 't', confidence: 1 }],
  prior_actions: [], truncated: false,
};
const openai = (plan) => ({ choices: [{ message: { content: JSON.stringify(plan) } }] });
const run = (plan) => normalizeProviderResponse(openai(plan), false, request);
const base = { reasoning_summary: 'x', requires_client_secret: false };

console.log('shape');
{
  const r = run({ ...base, actions: [{ action: 'click', selector: 'button#go' }] });
  check(r.done === false && r.result === null, 'done defaults false, result null');
  check(r.actions[0].risk === 'routine', 'risk defaults to routine');
}
{
  const r = run({ ...base, actions: [], done: true, result: 'PAN and OTP are empty.' });
  check(r.done === true && r.result === 'PAN and OTP are empty.', 'done/result pass through');
}
{
  const r = run({ ...base, actions: [], done: 'yes' });
  check(r.actions.length === 0 && r.guardrail_rejections?.length === 1, 'non-boolean done rejects the plan');
}

console.log('verbs');
{
  const r = run({ ...base, actions: [
    { action: 'select', selector: 'select#country', option: 'India' },
    { action: 'key', key: 'Enter' },
    { action: 'key', selector: 'input#user', key: 'Tab' },
    { action: 'hover', selector: 'button#go' },
    { action: 'scroll', direction: 'up' },
    { action: 'scroll' },
    { action: 'go_back' },
    { action: 'wait' },
    { action: 'navigate', url: 'https://example.com/a?b=1' },
  ] });
  check(r.actions.length === 9 && !r.guardrail_rejections, 'every valid v2 action survives');
  check(r.actions[8].risk === 'sensitive', 'navigate is forced sensitive');
  check(r.actions[5].direction === undefined, 'scroll direction stays absent when omitted');
}
{
  const r = run({ ...base, actions: [
    { action: 'select', selector: 'select#country' },
    { action: 'key', key: 'F5' },
    { action: 'navigate', url: 'javascript:alert(1)' },
    { action: 'navigate' },
    { action: 'scroll', direction: 'sideways' },
    { action: 'hover' },
    { action: 'focus', selector: 'input#user' },
    { action: 'read', selector: 'input#user' },
    { action: 'click', selector: 'button#go', risk: 'high' },
  ] });
  check(r.actions.length === 0, 'every malformed v2 action is dropped');
  check(r.guardrail_rejections.length === 9, `nine rejections recorded (${r.guardrail_rejections.length})`);
  check(r.guardrail_rejections.some((m) => /focus/.test(m) && /unknown action verb/.test(m)), 'focus is no longer a verb');
}

console.log('unchanged v1 rules');
{
  const r = run({ ...base, actions: [
    { action: 'click', selector: 'input#ssn' },
    { action: 'type', selector: 'input#password', value: 'hunter2' },
    { action: 'type', selector: 'input#user', value: '[EMAIL_1]' },
    { action: 'type', selector: 'input#user', value_ref: 'vault:user' },
    { action: 'type', selector: 'input#user' },
    { action: 'type', selector: 'input#password', value_ref: 'user_saved:password' },
  ] });
  check(r.actions.length === 1 && r.actions[0].value_ref === 'user_saved:password', 'only the value_ref type survives');
  check(r.requires_client_secret === true, 'requires_client_secret derived from actions');
}

console.log('value / value_ref only on type');
{
  const r = run({ ...base, actions: [
    { action: 'click', selector: 'button#go', value: 'x' },
    { action: 'select', selector: 'select#country', option: 'India', value_ref: 'user_saved:password' },
  ] });
  check(r.actions.length === 0 && r.guardrail_rejections.every((m) => /only apply to type/.test(m)), 'value on click and value_ref on select are rejected');
}

console.log('typed secrets (build-request)');
{
  await build({ entryPoints: ['src/redaction/build-request.ts', 'src/redaction/tokens.ts'], outdir: join(temp, 'br'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error', outExtension: { '.js': '.mjs' } });
  const { buildAgentRequest, assertNoTypedSecrets } = await import(`file://${join(temp, 'br', 'build-request.mjs')}`);
  const { TokenRegistry } = await import(`file://${join(temp, 'br', 'tokens.mjs')}`);
  const attrs = { id: 'u', name: 'u', autocomplete: null, placeholder: null, aria_label: null, alt: null, title: null, inputmode: null, maxlength: null };
  const node = { path: 'input#u', tag: 'input', role: 'textbox', label: 'Nickname', text: null, context_label: null, value: 'blue-heron-42', value_omitted: null, input_type: 'text', attrs, bbox: { x: 0, y: 0, width: 100, height: 20 }, interactive: true, media: null };
  const snapshot = { schema_version: 1, captured_at: '', page_url: 'https://a.example/', page_title: '', viewport: { width: 800, height: 600, device_pixel_ratio: 1, scroll_x: 0, scroll_y: 0 }, nodes: [node], truncated: false, unscanned: [], timings: { dom_walk_ms: 0 } };
  const opts = { snapshot, screenshotDataUrl: null, taskInstruction: 'g', tokens: new TokenRegistry('s') };
  const plain = (await buildAgentRequest(opts)).request;
  check(plain.dom_summary[0].value === 'blue-heron-42' && plain.redaction_manifest.length === 0, 'unforced field passes through');
  let threw = null;
  try { assertNoTypedSecrets(plain, ['blue-heron-42']); } catch (e) { threw = e; }
  check(threw?.name === 'RawPiiLeakError' && !threw.message.includes('blue-heron-42'), 'egress check throws without quoting the value');
  const forced = (await buildAgentRequest({ ...opts, tokens: new TokenRegistry('s2'), forceTier1Paths: new Set(['input#u']) })).request;
  const entry = forced.redaction_manifest.find((e) => e.dom_path === 'input#u');
  check(forced.dom_summary[0].value === '[REDACTED:PASSWORD]' && entry?.tier === 1 && entry.type === 'password' && entry.detector === 'agent:typed-secret' && entry.masking === 'blackbox', 'forced path is masked and declared Tier 1');
  let ok = true;
  try { assertNoTypedSecrets(forced, ['blue-heron-42']); } catch { ok = false; }
  check(ok, 'egress check passes once the value is masked');
}

console.log('plan split');
{
  await build({ entryPoints: ['src/shared/plan-split.ts'], outfile: join(temp, 'split.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  const { splitAtTabVerb } = await import(`file://${join(temp, 'split.mjs')}`);
  const a = { action: 'click', selector: 'button#go', risk: 'routine' };
  const n = { action: 'navigate', url: 'https://example.com', risk: 'sensitive' };
  const w = { action: 'wait', risk: 'routine' };
  const s1 = splitAtTabVerb([a, n, w]);
  check(s1.page.length === 1 && s1.tab === n && s1.dropped.length === 1, 'page verbs before the tab verb, the rest dropped');
  const s2 = splitAtTabVerb([a, w]);
  check(s2.page.length === 2 && s2.tab === null && s2.dropped.length === 0, 'no tab verb: everything is page');
  const s3 = splitAtTabVerb([{ action: 'go_back', risk: 'routine' }]);
  check(s3.page.length === 0 && s3.tab?.action === 'go_back', 'tab verb first');
}

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
