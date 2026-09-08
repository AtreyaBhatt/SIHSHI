/** Message protocol between popup ⇄ service worker ⇄ content script. */
import type { AgentRequest, CaptureResult, RawSnapshot } from './schema';
import type { Detection } from '../pii-detection/types';

export type PopupToWorker =
  | { type: 'ppva:run-capture' }
  | { type: 'ppva:get-last-capture' }
  | { type: 'ppva:build-payload'; threshold: number; task_instruction: string }
  | { type: 'ppva:reset-session' };

export type WorkerToContent = { type: 'ppva:capture-dom' };

export type ContentToWorker =
  | { ok: true; snapshot: RawSnapshot }
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
  error: string | null;
}

export type WorkerReply<T> = { ok: true; data: T } | { ok: false; error: string };

/** Ties each request to the shape it answers with, so the popup needs no casts. */
export type ResponseFor<M extends PopupToWorker> =
  M extends { type: 'ppva:run-capture' } ? CaptureResult
  : M extends { type: 'ppva:get-last-capture' } ? CaptureResult | null
  : M extends { type: 'ppva:build-payload' } ? PayloadPreview
  : M extends { type: 'ppva:reset-session' } ? { session_id: string }
  : never;
