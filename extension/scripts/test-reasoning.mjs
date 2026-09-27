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

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
