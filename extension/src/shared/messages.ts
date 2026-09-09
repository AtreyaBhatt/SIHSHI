/** Message protocol between popup ⇄ service worker ⇄ content script. */
import type { AgentRequest, AgentResponse, CaptureResult, RawSnapshot } from './schema';
import type { Detection } from '../pii-detection/types';
import type { ActionOutcome, ExecutableAction } from '../executor/execute';

/**
 * `tab_id` exists because the full-page viewer is itself a tab: without it the
 * worker would query for the active tab and capture the viewer instead of the
 * page under inspection. The popup can omit it — when the popup is open, the
 * active tab is the right one.
 */
export type PopupToWorker =
  | { type: 'ppva:run-capture'; tab_id?: number }
  | { type: 'ppva:get-last-capture' }
  | { type: 'ppva:build-payload'; threshold: number; task_instruction: string }
  | { type: 'ppva:reset-session' }
  | { type: 'ppva:request-plan'; threshold: number; task_instruction: string; tab_id?: number }
  | { type: 'ppva:execute-plan'; tab_id?: number }
  | { type: 'ppva:check-health' };

export type WorkerToContent =
  | { type: 'ppva:capture-dom' }
  | { type: 'ppva:execute'; actions: ExecutableAction[]; allowed_selectors: string[] };

export type ContentToWorker =
  | { ok: true; snapshot: RawSnapshot }
  | { ok: true; outcomes: ActionOutcome[] }
  | { ok: false; error: string };

/**
 * What the diff viewer renders. `request` is null whenever the redaction engine
 * refused to build one — the viewer shows the refusal rather than a payload.
 */
export interface PayloadPreview {
  session_id: string;
  request: AgentRequest | null;
  detections: Detection[];
  build_ms: number;
  /** What the local face detector did, or why it did nothing. */
  perception_note: string | null;
  error: string | null;
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
  status: string;
  provider: string;
  ingress_policy: string;
  server_url: string;
}

export type WorkerReply<T> = { ok: true; data: T } | { ok: false; error: string };

/** Ties each request to the shape it answers with, so the popup needs no casts. */
export type ResponseFor<M extends PopupToWorker> =
  M extends { type: 'ppva:run-capture' } ? CaptureResult
  : M extends { type: 'ppva:get-last-capture' } ? CaptureResult | null
  : M extends { type: 'ppva:build-payload' } ? PayloadPreview
  : M extends { type: 'ppva:reset-session' } ? { session_id: string }
  : M extends { type: 'ppva:request-plan' } ? PlanPreview
  : M extends { type: 'ppva:execute-plan' } ? ExecutionResult
  : M extends { type: 'ppva:check-health' } ? HealthReport
  : never;
