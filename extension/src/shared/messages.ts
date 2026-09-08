/** Message protocol between popup ⇄ service worker ⇄ content script. */
import type { CaptureResult, RawSnapshot } from './schema';

export type PopupToWorker =
  | { type: 'ppva:run-capture' }
  | { type: 'ppva:get-last-capture' };

export type WorkerToContent = { type: 'ppva:capture-dom' };

export type ContentToWorker =
  | { ok: true; snapshot: RawSnapshot }
  | { ok: false; error: string };

export type WorkerToPopup =
  | { ok: true; capture: CaptureResult | null }
  | { ok: false; error: string };
