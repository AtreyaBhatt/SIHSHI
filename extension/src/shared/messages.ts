/** Message protocol between extension pages ⇄ service worker ⇄ content script. */
import type { AgentRequest, AgentResponse, CaptureResult, RawSnapshot } from './schema';
import type { Detection } from '../pii-detection/types';
import type { FirewallReport } from '../redaction/firewall';
import type { ActionOutcome, ExecutableAction } from '../executor/execute';
import type { Run, RunMode } from '../background/agent/loop';
import type { VaultStatus } from './vault';
import type { DeltaReport } from './delta';

export type PanelToWorker =
  | { type: 'athena:run-capture'; tab_id?: number }
  | { type: 'athena:get-last-capture' }
  | { type: 'athena:build-payload'; threshold: number; task_instruction: string }
  | { type: 'athena:reset-session' }
  | { type: 'athena:request-plan'; threshold: number; task_instruction: string; tab_id?: number }
  | { type: 'athena:execute-plan'; tab_id?: number }
  | { type: 'athena:check-health' }
  | { type: 'athena:run-start'; goal: string; mode: RunMode; tab_id?: number }
  | { type: 'athena:run-approve'; step: number }
  | { type: 'athena:run-stop' }
  | { type: 'athena:run-get' }
  | { type: 'athena:run-grant-and-resume' }
  | { type: 'athena:debug-detectors'; names?: string[] }
  | { type: 'athena:vault-status' }
  | { type: 'athena:vault-create'; passphrase: string; confirm: string }
  | { type: 'athena:vault-unlock'; passphrase: string }
  | { type: 'athena:vault-lock' }
  | { type: 'athena:vault-set'; slot: string; value: string }
  | { type: 'athena:vault-delete'; slot: string }
  | { type: 'athena:vault-set-api-key'; value: string | null };

export type WorkerToContent =
  | { type: 'athena:capture-dom' }
  | { type: 'athena:execute'; actions: ExecutableAction[]; allowed_selectors: string[]; expected_origin: string }
  | { type: 'athena:settle' };

export type ContentToWorker =
  | { ok: true; snapshot: RawSnapshot }
  | { ok: true; outcomes: ActionOutcome[] }
  | { ok: true; settled: true }
  | { ok: false; error: string };

/** Pushed from the worker whenever a run transitions, so the panel can render without polling. */
export type WorkerToPanel = { type: 'athena:run-changed'; run: Run };

/**
 * Every rubric number for one step, measured in that step — nothing
 * hardcoded, nothing recomputed later. Counts, milliseconds, bytes,
 * percentages and the two enums only: never a value, a label, or selector
 * text (CLAUDE.md, phase 5b global constraints).
 *
 * `provider_ms`/`execute_ms`/`settle_ms` are null on the `PayloadPreview` this
 * came from (buildPayload never talks to the network, the executor or the
 * tab) and are filled in by the loop once those stages actually run, becoming
 * `Run.last_metrics`.
 */
export interface StepMetrics {
  capture_ms: number;
  screenshot_ms: number;
  perception_ms: number;
  redaction_ms: number;
  firewall_ms: number;
  provider_ms: number | null;
  execute_ms: number | null;
  settle_ms: number | null;
  /** JSON.stringify(request).length re-encoded as UTF-8 bytes via TextEncoder. */
  payload_bytes: number;
  /** 'redacted' only when request.screenshot_redacted is the output of redactScreenshot for this capture; 'none' when withheld or absent. */
  screenshot: 'redacted' | 'none';
  detected: number;
  redacted_tier1: number;
  redacted_tier2: number;
  faces: number;
  frames: number;
  firewall_masked: number;
  firewall_blocked: number;
  hidden_dropped: number;
}

export interface PayloadPreview {
  session_id: string;
  request: AgentRequest | null;
  detections: Detection[];
  /** The independent outbound scan's report (redaction/firewall.ts). Non-null even when the build fails with a Tier-1 block, so the panel can show what was blocked. */
  firewall: FirewallReport | null;
  build_ms: number;
  perception_note: string | null;
  error: string | null;
  /** What DeltaVision skipped this step, and how much. Null when the build failed before face detection ran. */
  delta: DeltaReport | null;
  /** Null when the build failed before a request existed to measure. */
  metrics: StepMetrics | null;
}

export interface PlanPreview {
  preview: PayloadPreview;
  response: AgentResponse | null;
  network_ms: number;
  error: string | null;
}

export interface ExecutionResult {
  outcomes: ActionOutcome[];
  execute_ms: number;
}

export interface HealthReport {
  base_url: string;
  model: string;
  format: 'openai' | 'anthropic';
  api_key_set: boolean;
  vault_locked: boolean;
}

export type WorkerReply<T> = { ok: true; data: T } | { ok: false; error: string };

export type ResponseFor<M extends PanelToWorker> =
  M extends { type: 'athena:run-capture' } ? CaptureResult
  : M extends { type: 'athena:get-last-capture' } ? CaptureResult | null
  : M extends { type: 'athena:build-payload' } ? PayloadPreview
  : M extends { type: 'athena:reset-session' } ? { session_id: string }
  : M extends { type: 'athena:request-plan' } ? PlanPreview
  : M extends { type: 'athena:execute-plan' } ? ExecutionResult
  : M extends { type: 'athena:check-health' } ? HealthReport
  : M extends { type: 'athena:run-start' } ? Run
  : M extends { type: 'athena:run-approve' } ? Run
  : M extends { type: 'athena:run-stop' } ? Run
  : M extends { type: 'athena:run-get' } ? Run | null
  : M extends { type: 'athena:run-grant-and-resume' } ? Run
  : M extends { type: 'athena:debug-detectors' } ? string[]
  : M extends { type: `athena:vault-${string}` } ? VaultStatus
  : never;
