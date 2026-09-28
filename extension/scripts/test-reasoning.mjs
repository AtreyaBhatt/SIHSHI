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
    { path: 'a#home', role: 'link', label: 'Home', value: null },
    { path: 'input#email', role: 'textbox', label: 'Email', value: '[EMAIL_1]' },
  ],
  redaction_manifest: [
    { id: 'PASSWORD_1', type: 'password', tier: 1, bbox: null, dom_path: 'input#password', masking: 'blackbox', detector: 't', confidence: 1 },
    { id: 'EMAIL_1', type: 'email', tier: 2, bbox: null, dom_path: 'input#email', masking: 'token', detector: 't', confidence: 1 },
  ],
  prior_actions: [], truncated: false, available_refs: [],
};
const openai = (plan) => ({ choices: [{ message: { content: JSON.stringify(plan) } }] });
const run = (plan) => normalizeProviderResponse(openai(plan), false, request);
const base = { reasoning_summary: 'x', requires_client_secret: false };

console.log('shape');
{
  const r = run({ ...base, actions: [{ action: 'click', selector: 'select#country' }] });
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

console.log('risk floor');
{
  const r = run({ ...base, actions: [
    { action: 'key', key: 'Enter', risk: 'routine' },
    { action: 'click', selector: 'button#go', risk: 'routine' },
    { action: 'type', selector: 'input#password', value_ref: 'user_saved:password', risk: 'routine' },
    { action: 'key', key: 'Tab', risk: 'routine' },
    { action: 'type', selector: 'input#user', value: 'abc', risk: 'routine' },
    { action: 'click', selector: 'a#home', risk: 'routine' },
    { action: 'type', selector: 'input#email', value: 'x', risk: 'routine' },
  ] });
  check(r.actions[0].risk === 'sensitive', 'key Enter is forced sensitive');
  check(r.actions[1].risk === 'sensitive', 'click on a button is forced sensitive');
  check(r.actions[2].risk === 'sensitive', 'type into a redacted field is forced sensitive');
  check(r.actions[3].risk === 'routine' && r.actions[4].risk === 'routine', 'Tab and typing into a plain field stay routine');
  check(r.actions[5].risk === 'sensitive', 'click on a link is forced sensitive');
  check(r.actions[6].risk === 'sensitive', 'type into a path with a Tier-2 manifest entry is forced sensitive');
}

console.log('value / value_ref only on type');
{
  const r = run({ ...base, actions: [
    { action: 'click', selector: 'button#go', value: 'x' },
    { action: 'select', selector: 'select#country', option: 'India', value_ref: 'user_saved:password' },
  ] });
  check(r.actions.length === 0 && r.guardrail_rejections.every((m) => /only apply to type/.test(m)), 'value on click and value_ref on select are rejected');
}

console.log('value_token');
{
  const req2 = { ...request, available_refs: ['user_saved:username', 'user_saved:aadhaar'], redaction_manifest: [
    ...request.redaction_manifest,
    { id: 'AADHAAR_1', type: 'aadhaar', tier: 1, bbox: null, dom_path: 'td#alt', masking: 'token', detector: 't', confidence: 1 },
    { id: 'PHONE_1', type: 'phone', tier: 2, bbox: null, dom_path: 'td#ph', masking: 'token', detector: 't', confidence: 1 },
    { id: 'AADHAAR_2', type: 'aadhaar', tier: 1, bbox: null, dom_path: 'input#aadhaar', masking: 'token', detector: 't', confidence: 1 },
    { id: 'PHONE_2', type: 'phone', tier: 2, bbox: null, dom_path: 'input#mobile', masking: 'token', detector: 't', confidence: 1 },
    { id: 'EMAIL_2', type: 'email', tier: 2, bbox: null, dom_path: 'td#fw', masking: 'token', detector: 'firewall:email', confidence: 1 },
    { id: 'AADHAAR_3', type: 'aadhaar', tier: 1, bbox: null, dom_path: 'input#aadhaar', masking: 'blackbox', detector: 'group:aadhaar', confidence: 0.9 },
  ], dom_summary: [...request.dom_summary,
    { path: 'input#aadhaar', role: 'textbox', label: 'Aadhaar', value: null },
    { path: 'input#mobile', role: 'textbox', label: 'Mobile', value: null },
  ] };
  const run2 = (plan) => normalizeProviderResponse(openai(plan), false, req2);
  const ok = run2({ ...base, actions: [
    { action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_1]' },
    { action: 'type', selector: 'input#mobile', value_token: '[PHONE_1]', risk: 'routine' },
    { action: 'type', selector: 'input#user', value_ref: 'user_saved:username', risk: 'routine' },
    { action: 'type', selector: 'input#email', value_token: '[EMAIL_1]', risk: 'routine' },
  ] });
  check(ok.actions.length === 4, `four valid token/ref types survive (${ok.guardrail_rejections?.join('; ')})`);
  check(ok.actions.every((a) => a.risk === 'sensitive'), 'value_token and value_ref are forced sensitive');
  check(ok.requires_client_secret === true, 'requires_client_secret covers tokens too');
  const bad = run2({ ...base, actions: [
    { action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_9]' },
    { action: 'type', selector: 'input#aadhaar', value_token: '[PASSWORD_1]' },
    { action: 'type', selector: 'input#aadhaar', value_token: 'AADHAAR_1' },
    { action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_1]', value: 'x' },
    { action: 'type', selector: 'input#user', value_ref: 'user_saved:nothing' },
    { action: 'click', selector: 'button#go', value_token: '[AADHAAR_1]' },
  ] });
  check(bad.actions.length === 0 && bad.guardrail_rejections.length === 6, `all six invalid token uses rejected (${bad.guardrail_rejections?.length})`);
  check(bad.guardrail_rejections.some((m) => /not a token from this request/.test(m)), 'unknown id names the rule');
  check(bad.guardrail_rejections.some((m) => /slot the user has not stored/.test(m)), 'value_ref outside available_refs names the rule');
  const noRefs = normalizeProviderResponse(openai({ ...base, actions: [{ action: 'type', selector: 'input#user', value_ref: 'user_saved:anything' }] }), false, { ...req2, available_refs: [] });
  check(noRefs.actions.length === 1, 'empty available_refs does not gate value_ref (backwards compatible)');

  // W3d: a token only fills a field declared as holding that same type.
  const mismatch = run2({ ...base, actions: [
    { action: 'type', selector: 'input#user', value_token: '[AADHAAR_1]' },
    { action: 'type', selector: 'input#aadhaar', value_token: '[PHONE_1]' },
    { action: 'type', selector: 'input#email', value_token: '[PHONE_1]' },
  ] });
  check(mismatch.actions.length === 0 && mismatch.guardrail_rejections.length === 3 && mismatch.guardrail_rejections.every((m) => /value_token type does not match the target field/.test(m)), `token into an undeclared or other-type field is rejected (${mismatch.guardrail_rejections?.join('; ')})`);

  // X4: a firewall-minted token is masked, never typeable; a cascade token of the same type is.
  const fw = run2({ ...base, actions: [{ action: 'type', selector: 'input#email', value_token: '[EMAIL_2]' }] });
  check(fw.actions.length === 0 && /not a token from this request/.test(fw.guardrail_rejections?.[0] ?? ''), `firewall-minted token rejected (${fw.guardrail_rejections?.join('; ')})`);
  const grp = run2({ ...base, actions: [{ action: 'type', selector: 'input#aadhaar', value_token: '[AADHAAR_3]' }] });
  check(grp.actions.length === 0 && /not a token from this request/.test(grp.guardrail_rejections?.[0] ?? ''), `split-field member id rejected as value_token (${grp.guardrail_rejections?.join('; ')})`);
  const cascade = run2({ ...base, actions: [{ action: 'type', selector: 'input#email', value_token: '[EMAIL_1]' }] });
  check(cascade.actions.length === 1 && !cascade.guardrail_rejections, 'cascade token of the same type into the same field survives');
}

console.log('multi-word marker echo');
{
  const r = run({ ...base, actions: [
    { action: 'type', selector: 'input#user', value: '[CARD_NUMBER_1]' },
    { action: 'type', selector: 'input#user', value: 'card [BANK_ACCOUNT_12] please' },
  ] });
  check(r.actions.length === 0 && r.guardrail_rejections.length === 2 && r.guardrail_rejections.every((m) => /echoes a redaction marker/.test(m)), `[CARD_NUMBER_1] is rejected as a marker echo (${r.guardrail_rejections?.join('; ')})`);
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

  // A later page can echo the typed value back in a node no detector flags
  // (e.g. a "Signed in as ..." banner) — build-request must catch that itself,
  // without needing the path to be in forceTier1Paths.
  const bannerNode = { path: 'div#banner', tag: 'div', role: null, label: 'Signed in as blue-heron-42', text: null, context_label: null, value: null, value_omitted: null, input_type: null, attrs, bbox: { x: 0, y: 40, width: 200, height: 20 }, interactive: false, media: null };
  const snapshotWithEcho = { ...snapshot, nodes: [node, bannerNode] };
  const echoed = (await buildAgentRequest({ snapshot: snapshotWithEcho, screenshotDataUrl: null, taskInstruction: 'g', tokens: new TokenRegistry('s3'), typedSecretValues: ['blue-heron-42'] })).request;
  const bannerOut = echoed.dom_summary.find((n) => n.path === 'div#banner');
  const bannerEntry = echoed.redaction_manifest.find((e) => e.dom_path === 'div#banner');
  check(
    bannerOut?.label === 'Signed in as [REDACTED:PASSWORD]'
      && bannerEntry?.type === 'password' && bannerEntry.tier === 1
      && bannerEntry.masking === 'blackbox' && bannerEntry.detector === 'agent:typed-secret-echo',
    'an echoed value elsewhere on the page is masked and declared',
  );
  let echoOk = true;
  try { assertNoTypedSecrets(echoed, ['blue-heron-42']); } catch { echoOk = false; }
  check(echoOk, 'egress check passes once the echo is masked');

  // X5: a value under four characters is neither masked nor treated as a leak.
  const accessNode = { ...bannerNode, path: 'div#access', label: 'Request access' };
  const short = (await buildAgentRequest({ snapshot: { ...snapshot, nodes: [accessNode] }, screenshotDataUrl: null, taskInstruction: 'g', tokens: new TokenRegistry('s5'), typedSecretValues: ['cs'] })).request;
  let shortOk = true;
  try { assertNoTypedSecrets(short, ['cs']); } catch { shortOk = false; }
  check(short.dom_summary[0].label === 'Request access' && short.redaction_manifest.length === 0 && shortOk, 'slot value "cs" does not mask "access" and does not trip the egress check');
  let idOk = true;
  try { assertNoTypedSecrets({ ...plain, session_id: 'blue-heron-42-session' }, ['blue-heron-42']); } catch { idOk = false; }
  check(idOk === false, 'sanity: the plain request still carries the value in dom_summary');
  let onlyId = true;
  try { assertNoTypedSecrets({ ...forced, session_id: 'blue-heron-42-session' }, ['blue-heron-42']); } catch { onlyId = false; }
  check(onlyId, 'egress check ignores fields outside dom_summary, task_instruction and prior_actions (session_id)');
  let inHistory = null;
  try { assertNoTypedSecrets({ ...forced, prior_actions: [{ action: 'type', selector: 'input#u', value: 'blue-heron-42', outcome: 'ok' }] }, ['blue-heron-42']); } catch (e) { inHistory = e; }
  check(inHistory?.name === 'RawPiiLeakError', 'egress check covers prior_actions values');

  const history = [{ verb: 'type', selector: 'input#u', value: 'mail abcd@gmail.com', outcome: 'ok' }];
  const withHistory = (await buildAgentRequest({ ...opts, tokens: new TokenRegistry('s4'), priorActions: history })).request;
  check(withHistory.prior_actions[0].value === 'mail [EMAIL_1]' && history[0].value === 'mail abcd@gmail.com', 'prior actions are masked in a copy; run history is untouched');

  // A Tier-1 entry already existing for a path must not be read as "already
  // masked" — a span-based detector can leave raw text (including the typed
  // secret) sitting next to its own redaction marker in the same field.
  const mixedNode = { path: 'input#notes', tag: 'input', role: 'textbox', label: 'Notes', text: null, context_label: null, value: '4111111111111111 blue-heron-42', value_omitted: null, input_type: 'text', attrs, bbox: { x: 0, y: 60, width: 100, height: 20 }, interactive: true, media: null };
  const snapshotMixed = { ...snapshot, nodes: [mixedNode] };
  const mixed = (await buildAgentRequest({ snapshot: snapshotMixed, screenshotDataUrl: null, taskInstruction: 'g', tokens: new TokenRegistry('s4'), forceTier1Paths: new Set(['input#notes']) })).request;
  const mixedOut = mixed.dom_summary.find((n) => n.path === 'input#notes');
  const forcedEntry = mixed.redaction_manifest.find((e) => e.dom_path === 'input#notes' && e.detector === 'agent:typed-secret');
  check(
    mixedOut?.value === '[REDACTED:PASSWORD]' && Boolean(forcedEntry),
    'forcing is skipped only for an already-whole-field marker, not whenever any Tier-1 entry exists for the path',
  );
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

console.log('registry values and tier-1 tokens');
{
  await build({ entryPoints: ['src/redaction/tokens.ts'], outfile: join(temp, 'tokens.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  await build({ entryPoints: ['src/redaction/redact-text.ts'], outfile: join(temp, 'redact-text.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  const { TokenRegistry } = await import(`file://${join(temp, 'tokens.mjs')}`);
  const { replacementFor } = await import(`file://${join(temp, 'redact-text.mjs')}`);
  const reg = new TokenRegistry('r1');
  const id = reg.idFor('aadhaar', '2345 6789 0124', 'input#aadhaar');
  check(id === 'AADHAAR_1', `first aadhaar token is AADHAAR_1 (${id})`);
  check(reg.valueOf('AADHAAR_1') === '2345 6789 0124', 'registry resolves the token to the original value');
  check(reg.idFor('aadhaar', '2345-6789-0124', 'td#alt') === 'AADHAAR_1', 'same value with different punctuation gets the same token');
  check(reg.valueOf('PASSWORD_1') === undefined, 'unknown id resolves to undefined');
  const empty = reg.idFor('otp', null, 'input#otp');
  check(reg.valueOf(empty) === undefined, 'a null value records no resolvable value');
  const copy = TokenRegistry.from(JSON.parse(JSON.stringify(reg)));
  check(copy.session_id === 'r1' && copy.valueOf('AADHAAR_1') === '2345 6789 0124' && copy.idFor('aadhaar', '2345 6789 0124', 'x') === 'AADHAAR_1', 'round-trips through JSON with counters intact');
  check(replacementFor('aadhaar', 1, 'AADHAAR_1', '2345 6789 0124') === '[AADHAAR_1]', 'resolvable tier-1 emits a numbered token');
  check(replacementFor('password', 1, 'PASSWORD_1', null) === '[REDACTED:PASSWORD]', 'password keeps the fixed marker');
  check(replacementFor('otp', 1, 'OTP_1', '123456') === '[REDACTED:OTP]', 'otp keeps the fixed marker');
  check(replacementFor('phone', 2, 'PHONE_1', '9845012345') === '[PHONE_1]', 'tier-2 unchanged');
}

console.log('firewall');
{
  await build({ entryPoints: ['src/redaction/firewall.ts'], outfile: join(temp, 'firewall.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  const { scanRequest, FIREWALL_RULES } = await import(`file://${join(temp, 'firewall.mjs')}`);
  const { TokenRegistry } = await import(`file://${join(temp, 'tokens.mjs')}`);
  const mk = (nodes, task = 'go') => ({ session_id: 's', task_instruction: task, screenshot_redacted: null, dom_summary: nodes, redaction_manifest: [], prior_actions: [], truncated: false, available_refs: ['user_saved:aadhaar'] });
  const nodesByPath = (nodes) => new Map(nodes.map((n) => [n.path, { path: n.path, bbox: [0, 0, 10, 10] }]));

  let req = mk([{ path: 'p#a', role: null, label: null, value: 'Mail us at abcd@gmail.com or call +91 98450 12345' }]);
  let rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 2 && rep.blocked === 0, `tier-2 email and phone are masked, not blocked (${rep.masked}/${rep.blocked})`);
  check(/\[EMAIL_1\].*\[PHONE_1\]/.test(req.dom_summary[0].value), `values replaced with tokens: ${req.dom_summary[0].value}`);
  check(req.redaction_manifest.length === 2 && req.redaction_manifest.every((e) => e.detector.startsWith('firewall:')), 'one manifest entry per masked hit, detector firewall:*');

  req = mk([{ path: 'p#u', role: null, label: null, value: 'pay priya@okaxis now' }]);
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 1 && rep.hits[0].type === 'account_id' && rep.hits[0].rule === 'upi', 'UPI id masked as account_id');

  req = mk([{ path: 'p#c', role: null, label: null, value: 'card 4539 1488 0343 6467' }]);
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 1 && rep.blocked === 0 && req.dom_summary[0].value === 'card [CARD_NUMBER_1]' && !req.dom_summary[0].value.includes('4539'), `tier-1 card is masked with a numbered token, not blocked (${req.dom_summary[0].value})`);
  check(req.redaction_manifest.some((e) => e.id === 'CARD_NUMBER_1' && e.tier === 1 && e.masking === 'token' && e.detector === 'firewall:card'), 'card gets a tier-1 manifest entry');

  req = mk([{ path: 'p#z', role: null, label: null, value: 'ref ４５３９１４８８０３４３６４６７' }]);
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 1 && req.dom_summary[0].value === 'ref [CARD_NUMBER_1]', `full-width digits are folded before matching, then masked (${req.dom_summary[0].value})`);
  check(req.redaction_manifest.some((e) => e.id === 'CARD_NUMBER_1' && e.tier === 1 && e.masking === 'token' && e.detector === 'firewall:card'), 'full-width card gets a tier-1 manifest entry');

  req = mk([{ path: 'p#i', role: null, label: null, value: 'GB29 NWBK 6016 1331 9268 19' }]);
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 1 && req.dom_summary[0].value === '[BANK_ACCOUNT_1]', `IBAN with valid mod-97 is masked, not blocked (${req.dom_summary[0].value})`);
  check(req.redaction_manifest.some((e) => e.id === 'BANK_ACCOUNT_1' && e.tier === 1 && e.masking === 'token' && e.detector === 'firewall:iban'), 'iban gets a tier-1 manifest entry');

  req = mk([{ path: 'p#ok', role: null, label: null, value: 'Order 12345 shipped, [EMAIL_1] notified, GB00 not an iban' }], 'help user_saved:aadhaar');
  rep = scanRequest(req, new TokenRegistry('s'), nodesByPath(req.dom_summary));
  check(rep.masked === 0 && rep.blocked === 0, 'short numbers, existing tokens and slot names do not fire');
  check(FIREWALL_RULES.every((r) => typeof r.name === 'string' && (r.regex instanceof RegExp) !== (typeof r.find === 'function')), 'rules table is data: each rule has a regex or a find, not both');

  const one = (value) => { const r = mk([{ path: 'p#x', role: null, label: null, value }]); let rep = null, err = null; try { rep = scanRequest(r, new TokenRegistry('s'), nodesByPath(r.dom_summary)); } catch (e) { err = e; } return { r, rep, err, out: r.dom_summary[0].value }; };
  let o = one('john+news@my-bank.com');
  check(o.out === '[EMAIL_1]' && o.r.redaction_manifest.length === 1 && o.r.redaction_manifest[0].id === 'EMAIL_1', `overlapping upi does not split an email (${o.out})`);
  o = one('a@b.co a@b.co');
  check(o.out === '[EMAIL_1] [EMAIL_1]' && o.r.redaction_manifest.length === 1, `repeated value: both replaced, one manifest entry (${o.out}, ${o.r.redaction_manifest.length})`);
  o = one('9845012345@ybl');
  check(o.out === '[ACCOUNT_ID_1]' && o.r.redaction_manifest.length === 1 && o.r.redaction_manifest[0].type === 'account_id', `UPI with a phone-number handle is one account_id (${o.out})`);
  o = one('[EMAIL_1]priya@okaxis');
  check(o.out === '[EMAIL_1][ACCOUNT_ID_1]', `marker-adjacent UPI id masked (${o.out})`);
  o = one('pay priya@okaxis.');
  check(o.out === 'pay [ACCOUNT_ID_1].', `UPI id before a full stop masked (${o.out})`);
  for (const v of ['+919845012345', '09845012345']) { o = one(`call ${v}`); check(o.out === 'call [PHONE_1]', `phone with prefix ${v} masked (${o.out})`); }
  // H1: a tier-1 firewall hit is masked with its numbered token, not blocked.
  for (const [v, rule, type, raw] of [
    ['4111 1111 1111 1111 12 28', 'card', 'card_number', '4111111111111111'],
    ['4111111111111111 123', 'card', 'card_number', '4111111111111111'],
    ['Order 5500 0055 5555 5559 0 items', 'card', 'card_number', '5500005555555559'],
    ['2345 6789 0124', 'aadhaar', 'aadhaar', '234567890124'],
    ['ABCDE1234F', 'pan', 'pan', 'ABCDE1234F'],
    ['SBIN0001234', 'ifsc', 'ifsc', 'SBIN0001234'],
    ['123-45-6789', 'ssn', 'ssn', '123-45-6789'],
  ]) {
    o = one(v);
    const tokenId = `${type.toUpperCase()}_1`;
    check(!o.err && o.rep?.masked === 1 && o.rep.hits[0].rule === rule && o.out.includes(`[${tokenId}]`) && !o.out.includes(raw), `${rule} masks with a ${type} token, not blocked (${o.err?.message ?? o.out})`);
    check(o.r.redaction_manifest.some((e) => e.id === tokenId && e.tier === 1 && e.masking === 'token' && e.detector === `firewall:${rule}`), `${rule} gets a tier-1 manifest entry`);
  }
  o = one('2345 6789 0125');
  check(!o.err && o.rep.masked === 0 && o.out === '2345 6789 0125', 'Verhoeff-invalid 12 digits pass unchanged');
  o = one('2345 6789 0124 1111');
  check(!o.err && o.rep.masked === 0 && o.out === '2345 6789 0124 1111', 'a valid Aadhaar digit-run embedded in a longer run is not masked (no Aadhaar window in a longer run)');
  o = one('Ｏｒｄｅｒ ｎｏ. ４２');
  check(o.out === 'Ｏｒｄｅｒ ｎｏ. ４２' && o.rep.masked === 0, 'text with no hits is returned unchanged (no NFKC rewrite)');
  o = one('Ｏｒｄｅｒ ４２ — a@b.co');
  check(o.out === 'Ｏｒｄｅｒ ４２ — [EMAIL_1]', `a hit is replaced in the original text (${o.out})`);

  // G1: offsets survive folds that change length before and after a hit.
  const lig = 'ﬁ'.repeat(10), comb = 'e\u0301'.repeat(10);
  o = one(`${lig} priya.sharma@gmail.com ${comb}`);
  check(o.out === `${lig} [EMAIL_1] ${comb}` && !o.out.includes('priya') && o.r.redaction_manifest.length === 1, `ligatures before, combining marks after: email masked in place (${o.out})`);
  o = one('call 98450 𝟏𝟐𝟑𝟒𝟓 today');
  check(o.out === 'call [PHONE_1] today', `phone with mathematical-bold digits masked in place (${o.out})`);
  o = one(`${'ﬁ'.repeat(3)} a@b.co ${'𝟏'.repeat(3)}`);
  check(!o.out.includes('a@b.co') && (o.err?.name === 'RawPiiLeakError' || o.out === `${'ﬁ'.repeat(3)} [EMAIL_1] ${'𝟏'.repeat(3)}`), `expansion before + contraction after (equal total length) never leaks (${o.out})`);
  // Fail-closed rescan: a probe that always finds another hit, however many
  // times it is masked, never converges within the three-pass cap — standing
  // in for a replacement bug — and blocks instead of sending.
  FIREWALL_RULES.push({ name: 'probe', type: 'phone', find: (s) => (s.length > 0 ? [{ start: 0, end: 1 }] : []) });
  o = one('mail a@b.co');
  FIREWALL_RULES.pop();
  check(o.err?.name === 'RawPiiLeakError' && o.err.message.includes('firewall:residual') && o.err.report.hits.some((h) => h.rule === 'residual' && h.action === 'blocked'), `a hit still present after the pass cap blocks (${o.err?.message ?? 'not blocked'})`);
  o = one('mail a@b.co zz');
  check(o.err === null && o.out === 'mail [EMAIL_1] zz', 'a clean rescan passes (probe removed)');

  // G2/H2: a card window inside a longer run needs a card-like shape.
  o = one('Tracking 1234 5678 9012 3456 7890');
  check(!o.err && o.rep.masked === 0 && o.rep.blocked === 0, `grouped tracking number passes untouched (${o.err?.message ?? 'ok'})`);
  o = one('4111111111111111@ybl');
  check(!o.err && o.rep.masked === 1 && o.rep.hits[0].rule === 'card' && o.out === '[CARD_NUMBER_1]@ybl', `card before upi: card-number UPI handle masks as card, not upi (${o.err?.message ?? o.out})`);

  // J1: masking a card window can leave a remainder that is itself a whole
  // digit run on the next pass — that gets its own token instead of blocking.
  o = one('4111 1111 1111 1111 2345 6789 0124');
  check(!o.err && o.rep.masked === 2 && o.rep.blocked === 0 && o.out === '[CARD_NUMBER_1] [AADHAAR_1]', `card and the aadhaar remainder it leaves behind are both masked, no throw (${o.err?.message ?? o.out})`);
  o = one('4111 1111 1111 1111 41111 11111 111111');
  check(!o.err && o.rep.masked >= 1, `a remainder that only becomes card-shaped after masking is absorbed within the pass cap, not blocked (${o.err?.message ?? o.out})`);
  // G4: ids left to right.
  o = one('a@b.co then c@d.co');
  check(o.out === '[EMAIL_1] then [EMAIL_2]', `token ids assigned left to right (${o.out})`);
}

console.log('demo detector switch');
{
  const session = {}; const local = { 'athena:debug-disabled-detectors': ['regex:email'] };
  const area = (store) => ({ get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (v) => { Object.assign(store, v); }, remove: async (k) => { delete store[k]; } });
  globalThis.chrome = { storage: { session: area(session), local: area(local) } };
  await build({ entryPoints: ['src/background/debug-detectors.ts'], outfile: join(temp, 'debug-detectors.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  const { setDisabledDetectors, readDisabledDetectors } = await import(`file://${join(temp, 'debug-detectors.mjs')}`);
  await new Promise((r) => setTimeout(r, 0));
  check(!('athena:debug-disabled-detectors' in local) && (await readDisabledDetectors()) === undefined, 'a switch left in storage.local by an earlier build is dropped');
  check(JSON.stringify(await setDisabledDetectors(['regex:email', 'dom:email'])) === '["regex:email","dom:email"]' && session['athena:debug-disabled-detectors'].length === 2, 'known names are stored in storage.session');
  let err = null; try { await setDisabledDetectors(['regex:email', 'regex:nope']); } catch (e) { err = e; }
  check(/cannot be switched off/.test(err?.message ?? '') && !err.message.includes('regex:nope') && session['athena:debug-disabled-detectors'].length === 2, 'an unknown name is rejected and nothing changes');
  for (const name of ['dom:input-type-password', 'regex:otp(context)', 'regex:bank_account(context)', 'dom:person-name', 'dom:account-id']) {
    err = null; try { await setDisabledDetectors([name]); } catch (e) { err = e; }
    check(/cannot be switched off/.test(err?.message ?? '') && session['athena:debug-disabled-detectors'].length === 2, `${name} (a type the firewall does not cover) is rejected`);
  }
  check((await setDisabledDetectors(['regex:phone-intl', 'dom:phone', 'regex:card_number+luhn', 'regex:aadhaar+verhoeff', 'regex:pan', 'regex:ifsc', 'regex:ssn'])).length === 7, 'every firewall-covered type can be switched off');
  await setDisabledDetectors(['regex:email', 'dom:email']);
  check((await setDisabledDetectors([])).length === 0 && (await readDisabledDetectors()) === undefined, 'an empty list clears the switch');
  await setDisabledDetectors(['regex:email']);
  check((await setDisabledDetectors('regex:email')).length === 0 && (await readDisabledDetectors()) === undefined, 'a non-array names value is treated as an empty list');
  delete globalThis.chrome;
}

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
