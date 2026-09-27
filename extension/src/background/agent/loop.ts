/**
 * The agent loop as a pure state machine. Every side effect goes through
 * LoopDeps so this file has no chrome.* import and is tested in Node.
 *
 * Transitions (spec §Phase 4): capturing → planning → (done & no actions → done)
 * | gate → awaiting_approval | executing → settling → capturing, step++.
 * step > max_steps → failed('step cap'). Any throw → failed(message).
 * After a navigation to an origin without host permission → needs_permission.
 * Execution hits a locked vault → needs_unlock (plan kept; approve() resumes).
 * Planning hits a locked vault (API key) → needs_unlock with no plan; the step
 * is not counted, and approve() re-captures.
 */
import type { AgentAction, AgentResponse, CaptureResult, PriorAction } from '../../shared/schema';
import type { PayloadPreview, StepMetrics } from '../../shared/messages';

export type RunMode = 'approve-all' | 'approve-sensitive';
export type RunStatus = 'idle' | 'capturing' | 'planning' | 'awaiting_approval' | 'executing' | 'settling' | 'needs_permission' | 'needs_unlock' | 'done' | 'failed' | 'stopped';

export interface Run {
  run_id: string;
  tab_id: number;
  goal: string;
  mode: RunMode;
  step: number;
  max_steps: number;
  status: RunStatus;
  history: PriorAction[];
  pending: AgentResponse | null;
  last_preview: PayloadPreview | null;
  result: string | null;
  error: string | null;
  needs_origin?: string;
  /** URL of the last capture; execution is checked against its origin. */
  page_url: string | null;
  /** dom_summary paths of the last capture — the executor's allowlist. */
  allowed: string[];
  /** Tier-1 dom_paths of the last capture; the panel flags a value_ref aimed elsewhere. */
  tier1_paths: string[];
  /** dom_summary labels (≤ 80 chars, already sanitized) of the pending plan's targets, keyed by path; shown on the approval card. */
  labels: Record<string, string>;
  /** The last fully-settled step's metrics (build-time fields plus provider/execute/settle ms). Null before any step completes. */
  last_metrics: StepMetrics | null;
  /**
   * Scratch space for the step in progress: provider_ms lands here at plan
   * time, execute_ms/settle_ms at execute time — often across two separate
   * drive()/approve() calls, since a plan can sit at awaiting_approval for a
   * while. Folded into last_metrics once the step reaches capturing/done and
   * cleared; never shown to the panel directly.
   */
  pending_metrics: { provider_ms?: number; execute_ms?: number; settle_ms?: number } | null;
}

export interface LoopDeps {
  capture(tabId: number): Promise<CaptureResult>;
  plan(capture: CaptureResult, goal: string, history: PriorAction[], runId: string): Promise<{ preview: PayloadPreview; response: AgentResponse; ms?: number }>;
  execute(tabId: number, actions: AgentAction[], allowed: string[], pageUrl: string, runId: string): Promise<{ history: PriorAction[]; ms?: number }>;
  /** Waits for the tab to load and the DOM to go quiet; reports where it landed and whether we may inject there. */
  settle(tabId: number): Promise<{ url: string | undefined; granted: boolean; ms?: number }>;
  save(run: Run): Promise<void>;
  /** True once stop() was requested for this run while a drive was in flight. */
  stopped(runId: string): boolean;
}

/** Merges this step's build-time metrics (from the just-stored preview) with whatever provider/execute/settle timings have landed so far. */
function finalizeMetrics(preview: PayloadPreview | null, pending: Run['pending_metrics']): StepMetrics | null {
  if (!preview?.metrics) return null;
  return {
    ...preview.metrics,
    provider_ms: pending?.provider_ms ?? preview.metrics.provider_ms,
    execute_ms: pending?.execute_ms ?? preview.metrics.execute_ms,
    settle_ms: pending?.settle_ms ?? preview.metrics.settle_ms,
  };
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'stopped']);

export function newRun(goal: string, tabId: number, mode: RunMode, maxSteps: number): Run {
  return {
    run_id: crypto.randomUUID(), tab_id: tabId, goal, mode, step: 0, max_steps: maxSteps, status: 'idle',
    history: [], pending: null, last_preview: null, result: null, error: null, page_url: null, allowed: [], tier1_paths: [], labels: {},
    last_metrics: null, pending_metrics: null,
  };
}

export function needsApproval(run: Run, response: AgentResponse): boolean {
  if (run.mode === 'approve-all') return true;
  return response.actions.some((a) => a.value_ref !== undefined || a.value_token !== undefined || a.risk === 'sensitive' || a.action === 'navigate');
}

export function stop(run: Run): Run {
  if (TERMINAL.has(run.status)) return run;
  return { ...run, status: 'stopped', pending: null };
}

async function transition(run: Run, patch: Partial<Run>, deps: LoopDeps): Promise<Run> {
  // A stop always wins: if one landed while we were off doing async work (a
  // plan call, an execute call, a settle call) for this run, override
  // whatever the caller wanted to transition to — unless it was already
  // heading to 'stopped'. Every exit path in drive()/executePending() goes
  // through here, so this covers stop arriving during deps.plan, deps.execute,
  // deps.settle, and the done/needs_permission exits, not just the top of the
  // drive loop.
  const next = deps.stopped(run.run_id) && patch.status !== 'stopped'
    ? { ...run, ...patch, status: 'stopped' as const, pending: null }
    : { ...run, ...patch };
  await deps.save(next);
  return next;
}

function originOf(url: string | undefined): string | null {
  try {
    if (!url) return null;
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch { return null; }
}

/** Execute the pending plan, settle, and hand back to drive(). */
async function executePending(run: Run, deps: LoopDeps): Promise<Run> {
  if (!run.pending) return transition(run, { status: 'failed', error: 'interrupted mid-execution; start again', pending: null }, deps);
  const response = run.pending;
  run = await transition(run, { status: 'executing', pending: null }, deps);
  if (run.status === 'stopped') return run;
  let executed: PriorAction[];
  let executeMs: number | undefined;
  try {
    const result = await deps.execute(run.tab_id, response.actions, run.allowed, run.page_url ?? '', run.run_id);
    executed = result.history;
    executeMs = result.ms;
  } catch (err) {
    // Matched by name so this file stays free of the (worker-only) vault module.
    // Values are resolved before anything runs, so nothing executed: keep the plan.
    if ((err as Error | null)?.name === 'VaultLockedError') return transition(run, { status: 'needs_unlock', pending: response }, deps);
    throw err;
  }
  const afterExecute = { ...run.pending_metrics, ...(executeMs !== undefined ? { execute_ms: executeMs } : {}) };
  run = await transition(run, { history: [...run.history, ...executed], status: 'settling', pending_metrics: afterExecute }, deps);
  if (response.done) {
    return transition(run, {
      status: 'done', result: response.result,
      last_metrics: finalizeMetrics(run.last_preview, afterExecute), pending_metrics: null,
    }, deps);
  }
  const landed = await deps.settle(run.tab_id);
  const afterSettle = { ...afterExecute, ...(landed.ms !== undefined ? { settle_ms: landed.ms } : {}) };
  if (!landed.granted) {
    return transition(run, {
      status: 'needs_permission', needs_origin: originOf(landed.url) ?? undefined,
      last_metrics: finalizeMetrics(run.last_preview, afterSettle), pending_metrics: null,
    }, deps);
  }
  return transition(run, {
    status: 'capturing',
    last_metrics: finalizeMetrics(run.last_preview, afterSettle), pending_metrics: null,
  }, deps);
}

/**
 * Advances the run until it needs a human (awaiting_approval, needs_permission, needs_unlock)
 * or ends. Safe to call on any status: terminal runs return unchanged, an
 * awaiting run returns unchanged (use approve()).
 */
export async function drive(run: Run, deps: LoopDeps): Promise<Run> {
  try {
    if (run.status === 'idle') run = await transition(run, { status: 'capturing' }, deps);
    while (!TERMINAL.has(run.status) && run.status !== 'awaiting_approval' && run.status !== 'needs_permission' && run.status !== 'needs_unlock') {
      if (deps.stopped(run.run_id)) return transition(run, { status: 'stopped', pending: null }, deps);

      if (run.status === 'capturing') {
        if (run.step >= run.max_steps) return transition(run, { status: 'failed', error: `step cap of ${run.max_steps} reached` }, deps);
        const capture = await deps.capture(run.tab_id);
        run = await transition(run, {
          step: run.step + 1, status: 'planning', page_url: capture.snapshot.page_url,
        }, deps);
        let planned: Awaited<ReturnType<LoopDeps['plan']>>;
        try {
          planned = await deps.plan(capture, run.goal, run.history, run.run_id);
        } catch (err) {
          // Matched by name (see executePending). The step did not happen.
          if ((err as Error | null)?.name === 'VaultLockedError') return transition(run, { status: 'needs_unlock', pending: null, step: run.step - 1 }, deps);
          throw err;
        }
        const { preview, response } = planned;
        run = await transition(run, {
          // The panel never reads the screenshot; keep the stored run small.
          last_preview: preview.request ? { ...preview, request: { ...preview.request, screenshot_redacted: null } } : preview,
          allowed: preview.request?.dom_summary.map((n) => n.path) ?? [],
          tier1_paths: preview.request?.redaction_manifest.filter((e) => e.tier === 1 && e.dom_path).map((e) => e.dom_path!) ?? [],
          // Fresh scratch for the step that just planned; execute()/settle() add to it.
          pending_metrics: planned.ms !== undefined ? { provider_ms: planned.ms } : null,
        }, deps);
        if (response.done && response.actions.length === 0) {
          return transition(run, {
            status: 'done', result: response.result,
            last_metrics: finalizeMetrics(run.last_preview, run.pending_metrics), pending_metrics: null,
          }, deps);
        }
        if (response.actions.length === 0) {
          // Nothing to do and not done: re-capturing would loop on the same page. The run cannot advance.
          const why = response.guardrail_rejections?.length ? response.guardrail_rejections.join('; ') : response.reasoning_summary;
          return transition(run, { status: 'failed', error: why }, deps);
        }
        const targets = new Set(response.actions.map((a) => a.selector));
        const labels = Object.fromEntries((preview.request?.dom_summary ?? [])
          .filter((n) => targets.has(n.path) && n.label)
          .map((n) => [n.path, n.label!.slice(0, 80)]));
        run = await transition(run, { pending: response, labels, status: needsApproval(run, response) ? 'awaiting_approval' : 'executing' }, deps);
        continue;
      }
      if (run.status === 'executing') { run = await executePending(run, deps); continue; }
      if (run.status === 'settling') { run = await transition(run, { status: 'capturing' }, deps); continue; }
      if (run.status === 'planning') { run = await transition(run, { status: 'capturing' }, deps); continue; } // resumed mid-plan after a worker restart: re-plan from a fresh capture
    }
    return run;
  } catch (err) {
    return transition(run, { status: 'failed', error: err instanceof Error ? err.message : String(err), pending: null }, deps);
  }
}

export async function approve(run: Run, deps: LoopDeps): Promise<Run> {
  // needs_unlock without a plan: planning was blocked, so resume from a fresh capture.
  if (run.status === 'needs_unlock' && !run.pending) return drive(await transition(run, { status: 'capturing' }, deps), deps);
  if ((run.status !== 'awaiting_approval' && run.status !== 'needs_unlock') || !run.pending) return run;
  return drive(await transition(run, { status: 'executing' }, deps), deps);
}
