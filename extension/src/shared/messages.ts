/** Message protocol between extension pages ⇄ service worker ⇄ content script. */
import type { AgentRequest, AgentResponse, CaptureResult, RawSnapshot } from './schema';
import type { Detection } from '../pii-detection/types';
import type { ActionOutcome, ExecutableAction } from '../executor/execute';

export type PanelToWorker =
  | { type: 'athena:run-capture'; tab_id?: number }
  | { type: 'athena:get-last-capture' }
  | { type: 'athena:build-payload'; threshold: number; task_instruction: string }
  | { type: 'athena:reset-session' }
  | { type: 'athena:request-plan'; threshold: number; task_instruction: string; tab_id?: number }
  | { type: 'athena:execute-plan'; tab_id?: number }
  | { type: 'athena:check-health' };

export type WorkerToContent =
  | { type: 'athena:capture-dom' }
  | { type: 'athena:execute'; actions: ExecutableAction[]; allowed_selectors: string[] };

export type ContentToWorker =
  | { ok: true; snapshot: RawSnapshot }
  | { ok: true; outcomes: ActionOutcome[] }
  | { ok: false; error: string };

export interface PayloadPreview {
  session_id: string;
  request: AgentRequest | null;
  detections: Detection[];
  build_ms: number;
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
  base_url: string;
  model: string;
  format: 'openai' | 'anthropic';
  api_key_set: boolean;
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
  : never;
