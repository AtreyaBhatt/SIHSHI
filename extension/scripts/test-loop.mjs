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
