/**
 * The agent loop as a state machine, driven with fake deps. Node only.
 * Usage: npm run test:loop
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-loop-'));
await build({ entryPoints: ['src/background/agent/loop.ts'], outfile: join(temp, 'loop.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
const { newRun, drive, approve, stop, needsApproval } = await import(`file://${join(temp, 'loop.mjs')}`);

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.error(`  FAIL ${msg}`); } };

// True if `seq` appears, in order (not necessarily contiguously), inside `arr`.
const isSubsequence = (seq, arr) => {
  let i = 0;
  for (const x of arr) { if (i < seq.length && x === seq[i]) i++; }
  return i === seq.length;
};

const capture = { tab_id: 7, snapshot: { page_url: 'https://bank.example/login', nodes: [], viewport: {}, truncated: false, unscanned: [], timings: {} }, screenshot_data_url: null, screenshot_error: null, timings: {} };
const preview = { session_id: 'r', request: { session_id: 'r', task_instruction: 'g', screenshot_redacted: null, dom_summary: [{ path: 'input#u', role: 'textbox', label: 'User', value: null }, { path: 'button#go', role: 'button', label: 'Go', value: null }], redaction_manifest: [], prior_actions: [], truncated: false }, detections: [], build_ms: 1, perception_note: null, error: null };
const plan = (actions, done = false, result = null) => ({ session_id: 'r', reasoning_summary: 's', actions, requires_client_secret: actions.some((a) => a.value_ref), done, result });
const login = [{ action: 'type', selector: 'input#u', value_ref: 'user_saved:username', risk: 'routine' }, { action: 'click', selector: 'button#go', risk: 'sensitive' }];

function fakeDeps(plans, opts = {}) {
  const log = [];
  const stoppedIds = new Set();
  const saved = [];
  return {
    log, stoppedIds, saved,
    capture: async (tabId) => { log.push('capture'); return { ...capture, tab_id: tabId }; },
    plan: async (_c, _g, history) => { log.push(`plan(${history.length})`); return { preview, response: plans.shift() ?? plan([], true, 'nothing left') }; },
    execute: async (_t, actions) => {
      log.push(`execute(${actions.length})`);
      const failThisCall = opts.failFirst && log.filter((l) => l.startsWith('execute')).length === 1;
      return actions.map((a) => {
        const outcome = failThisCall ? 'failed' : 'ok';
        return { ...a, outcome, ...(outcome === 'failed' ? { error: 'No element matches' } : {}) };
      });
    },
    settle: async () => { log.push('settle'); return { url: opts.afterUrl ?? 'https://bank.example/home', granted: opts.granted ?? true }; },
    save: async (run) => { saved.push(run); },
    stopped: (id) => stoppedIds.has(id),
  };
}

console.log('mode approve-all');
{
  const deps = fakeDeps([plan(login), plan([], true, 'Logged in.')]);
  let run = await drive(newRun('log in', 7, 'approve-all', 25), deps);
  check(run.status === 'awaiting_approval' && run.pending?.actions.length === 2, 'pauses for approval with the plan pending');
  check(run.step === 1, 'step counts from 1');
  run = await approve(run, deps);
  check(run.status === 'done' && run.result === 'Logged in.', `ends done with the result (${run.status})`);
  check(run.history.length === 2 && run.history.every((h) => h.outcome === 'ok'), 'history has both actions ok');
  check(deps.log.join(' ') === 'capture plan(0) execute(2) settle capture plan(2)', `transition order: ${deps.log.join(' ')}`);
  check(run.step === 2, 'second step counted');
  const savedStatuses = deps.saved.map((r) => r.status);
  check(savedStatuses[savedStatuses.length - 1] === 'done', `last saved status is done (${savedStatuses[savedStatuses.length - 1]})`);
  check(
    isSubsequence(['capturing', 'planning', 'awaiting_approval', 'executing', 'settling', 'capturing', 'planning', 'done'], savedStatuses),
    `saved status sequence contains the expected subsequence: ${savedStatuses.join(',')}`,
  );
}

console.log('mode approve-sensitive');
{
  const routine = [{ action: 'scroll', risk: 'routine' }];
  const deps = fakeDeps([plan(routine), plan(login), plan([], true, 'ok')]);
  let run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'awaiting_approval', 'routine step ran unattended, sensitive step paused');
  check(run.history.length === 1 && run.history[0].action === 'scroll', 'routine action already in history');
  check(needsApproval(run, plan([{ action: 'type', selector: 'input#u', value_ref: 'user_saved:x', risk: 'routine' }])) === true, 'value_ref requires approval');
  check(needsApproval(run, plan([{ action: 'type', selector: 'input#u', value_token: '[AADHAAR_1]', risk: 'routine' }])) === true, 'value_token requires approval');
  check(needsApproval(run, plan([{ action: 'navigate', url: 'https://a.example', risk: 'routine' }])) === true, 'navigate requires approval');
  check(needsApproval(run, plan([{ action: 'click', selector: 'button#go', risk: 'routine' }])) === false, 'routine click does not');
  run = await approve(run, deps);
  check(run.status === 'done', 'completes after approval');
}
{
  const deps = fakeDeps([plan([], true, 'PAN and OTP are empty.')]);
  const run = await drive(newRun('what is missing', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'done' && run.result === 'PAN and OTP are empty.' && run.history.length === 0, 'done with no actions ends without approval');
}

console.log('not done and no actions');
{
  const deps = fakeDeps([{ ...plan([]), guardrail_rejections: ['action[0] click: selector was not in dom_summary', 'action[1] type: needs exactly one of value / value_ref'] }]);
  const run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'failed' && run.error === 'action[0] click: selector was not in dom_summary; action[1] type: needs exactly one of value / value_ref', `fails with the rejections (${run.status}: ${run.error})`);
}
{
  const deps = fakeDeps([{ ...plan([]), reasoning_summary: 'No login form on this page.' }]);
  const run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'failed' && run.error === 'No login form on this page.', `fails with the reasoning summary (${run.status}: ${run.error})`);
}

console.log('done with actions');
{
  const deps = fakeDeps([plan([{ action: 'click', selector: 'button#go', risk: 'routine' }], true, 'Clicked.')]);
  const run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'done' && run.history.length === 1 && deps.log.filter((l) => l === 'capture').length === 1, 'executes then finishes without another capture');
}

console.log('failures and caps');
{
  const deps = fakeDeps([plan([{ action: 'click', selector: 'button#go', risk: 'routine' }]), plan([], true, 'gave up')], { failFirst: true });
  const run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'done' && run.history[0].outcome === 'failed' && run.history[0].error === 'No element matches', 'a failed action goes into history and the loop continues');
}
{
  const many = Array.from({ length: 30 }, () => plan([{ action: 'scroll', risk: 'routine' }]));
  const run = await drive(newRun('g', 7, 'approve-sensitive', 3), fakeDeps(many));
  check(run.status === 'failed' && /step cap/.test(run.error), `step cap fails the run (${run.status}: ${run.error})`);
  check(run.step === 3, `stopped at max_steps (${run.step})`);
}
{
  const deps = fakeDeps([plan(login)]);
  deps.plan = async () => { throw new Error('Provider returned HTTP 500.'); };
  const run = await drive(newRun('g', 7, 'approve-all', 25), deps);
  check(run.status === 'failed' && run.error === 'Provider returned HTTP 500.', 'a thrown error fails the run with its message');
}

console.log('stop and permission');
{
  const deps = fakeDeps([plan(login)]);
  let run = await drive(newRun('g', 7, 'approve-all', 25), deps);
  run = stop(run);
  check(run.status === 'stopped' && run.pending === null, 'stop from awaiting_approval');
  const again = await drive(run, deps);
  check(again.status === 'stopped', 'drive on a terminal run is a no-op');
}
{
  const deps = fakeDeps([plan([{ action: 'navigate', url: 'https://other.example', risk: 'routine' }])], { afterUrl: 'https://other.example/', granted: false });
  let run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  run = await approve(run, deps);
  check(run.status === 'needs_permission' && run.needs_origin === 'https://other.example', `navigation to an ungranted origin pauses (${run.status})`);
}

console.log('stop lands during execute (transition keeps the patch)');
{
  const deps = fakeDeps([plan(login)]);
  let run = await drive(newRun('g', 7, 'approve-all', 25), deps);
  deps.execute = async (_t, actions) => {
    deps.log.push(`execute(${actions.length})`);
    deps.stoppedIds.add(run.run_id);
    return actions.map((a) => ({ ...a, outcome: 'ok' }));
  };
  run = await approve(run, deps);
  check(
    run.status === 'stopped' && run.history.length === 2,
    `stop during execute still records the executed history (${run.status}, history=${run.history.length})`,
  );
}

console.log('settle on an unusable origin (about:blank) never sets needs_origin');
{
  const deps = fakeDeps([plan([{ action: 'navigate', url: 'https://other.example', risk: 'routine' }])]);
  deps.settle = async () => { deps.log.push('settle'); return { url: 'about:blank', granted: false }; };
  let run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  run = await approve(run, deps);
  check(
    run.status === 'needs_permission' && run.needs_origin === undefined,
    `landing on an unusable origin pauses without a resumable origin (${run.status}, needs_origin=${run.needs_origin})`,
  );
}

console.log('stop lands during plan');
{
  const deps = fakeDeps([plan(login)]);
  deps.plan = async (_c, _g, history, runId) => {
    deps.log.push(`plan(${history.length})`);
    deps.stoppedIds.add(runId);
    return { preview, response: plan(login) };
  };
  const run = await drive(newRun('g', 7, 'approve-all', 25), deps);
  check(run.status === 'stopped' && run.pending === null, `stop landing mid-plan wins over the pending plan (${run.status})`);
  const lastSaved = deps.saved[deps.saved.length - 1];
  check(lastSaved?.status === 'stopped', `last saved status is stopped (${lastSaved?.status})`);
}

console.log('tier1_paths');
{
  const tier1Preview = { ...preview, request: { ...preview.request, screenshot_redacted: 'data:image/png;base64,AAAA', dom_summary: [...preview.request.dom_summary, { path: 'input#p', role: 'textbox', label: 'Password', value: '[REDACTED:PASSWORD]' }], redaction_manifest: [{ id: 'PASSWORD_1', type: 'password', tier: 1, bbox: null, dom_path: 'input#p', masking: 'blackbox', detector: 't', confidence: 1 }] } };
  const deps = fakeDeps([plan([{ action: 'type', selector: 'input#u', value_ref: 'user_saved:password', risk: 'routine' }])]);
  deps.plan = async () => ({ preview: tier1Preview, response: plan([{ action: 'type', selector: 'input#u', value_ref: 'user_saved:password', risk: 'routine' }]) });
  const run = await drive(newRun('g', 7, 'approve-sensitive', 25), deps);
  check(run.status === 'awaiting_approval' && run.tier1_paths.includes('input#p') && !run.tier1_paths.includes(run.pending.actions[0].selector), `value_ref into a non-Tier-1 path: tier1_paths excludes it (${run.tier1_paths})`);
  check(run.last_preview.request.screenshot_redacted === null, 'stored preview drops the screenshot');
  check(JSON.stringify(run.labels) === '{"input#u":"User"}', `labels hold the pending targets' dom_summary labels only (${JSON.stringify(run.labels)})`);
}

console.log('stop before approval executes nothing');
{
  const deps = fakeDeps([plan(login)]);
  let run = await drive(newRun('g', 7, 'approve-all', 25), deps);
  deps.stoppedIds.add(run.run_id);
  run = await approve(run, deps);
  check(run.status === 'stopped' && !deps.log.some((l) => l.startsWith('execute')), `nothing executes after a stop (${deps.log.join(' ')})`);
}

console.log('needs_unlock');
{
  const deps = fakeDeps([plan(login, true, 'Logged in.')]);
  const realExecute = deps.execute;
  let locked = true;
  deps.execute = async (...args) => {
    if (locked) { locked = false; throw Object.assign(new Error('locked'), { name: 'VaultLockedError' }); }
    return realExecute(...args);
  };
  let run = await drive(newRun('log in', 7, 'approve-all', 25), deps);
  run = await approve(run, deps);
  check(run.status === 'needs_unlock' && run.pending?.actions.length === 2 && run.history.length === 0, `a locked vault pauses with the plan kept (${run.status})`);
  run = await approve(run, deps);
  check(run.status === 'done' && run.history.length === 2, `approve after unlock resumes to done (${run.status})`);
}

console.log('needs_unlock while planning');
{
  const deps = fakeDeps([plan([], true, 'Done.')]);
  const realPlan = deps.plan;
  let locked = true;
  deps.plan = async (...args) => {
    if (locked) { locked = false; deps.log.push('plan-locked'); throw Object.assign(new Error('locked'), { name: 'VaultLockedError' }); }
    return realPlan(...args);
  };
  let run = await drive(newRun('g', 7, 'approve-all', 25), deps);
  check(run.status === 'needs_unlock' && run.pending === null && run.step === 0, `a locked vault during planning pauses with no plan, step not counted (${run.status}, step ${run.step})`);
  run = await approve(run, deps);
  check(run.status === 'done' && run.step === 1, `approve re-captures and finishes (${run.status}, step ${run.step})`);
  check(deps.log.join(' ') === 'capture plan-locked capture plan(0)', `order: ${deps.log.join(' ')}`);
}

console.log('resume guard');
{
  const deps = fakeDeps([]);
  const interrupted = {
    run_id: 'r-interrupted', tab_id: 7, goal: 'g', mode: 'approve-all', step: 1, max_steps: 25,
    status: 'executing', history: [], pending: null, last_preview: null, result: null, error: null,
    page_url: 'https://bank.example/login', allowed: [],
  };
  const run = await drive(interrupted, deps);
  check(run.status === 'failed' && /interrupted/.test(run.error), `drive() on executing with no pending plan fails as interrupted (${run.status}: ${run.error})`);
}

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
