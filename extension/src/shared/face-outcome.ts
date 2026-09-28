/**
 * Pure decision extracted from background/service-worker.ts's `detectFaces`:
 * given the face detector's reply (or a thrown error) for this step, and the
 * capture's screenshot, decide what the rest of the pipeline does with it.
 *
 * No `chrome.*`, no DOM — the worker is the only caller with side effects
 * (it awaits `ensureOffscreen()` / `api.runtime.sendMessage`, catches, and
 * hands the outcome of that call to this function).
 *
 * A detector that actually failed (an `ok: false` reply, or a thrown error)
 * withholds the screenshot for this step: an unscanned image can hide an
 * unblurred face, so a page that cannot be proven face-clean must not leave
 * the device as pixels. Text redaction is unaffected either way — this
 * decision only ever gates the screenshot.
 *
 * "No screenshot to scan" is not a failure: there was nothing to withhold in
 * the first place.
 */
import type { FaceDetection } from '../perception/face-detect';
import type { DetectFacesReply } from '../perception/offscreen';

export interface FaceOutcome {
  faces: FaceDetection[];
  /** The screenshot to include in this step's request, or null to withhold it. */
  screenshotForRequest: string | null;
  note: string | null;
  /** True only when the detector actually failed (never for "no screenshot"). */
  failed: boolean;
}

export function resolveFaceOutcome(params: {
  screenshotDataUrl: string | null;
  reusedDetections: FaceDetection[];
  reusedFacesCount: number;
  /** The detector's reply, or null/undefined if the call never returned one. */
  reply: DetectFacesReply | null | undefined;
  /** Set (to anything) when the detector call threw. */
  thrown?: unknown;
}): FaceOutcome {
  const { screenshotDataUrl, reusedDetections, reusedFacesCount, reply, thrown } = params;

  if (screenshotDataUrl === null) {
    return { faces: reusedDetections, screenshotForRequest: null, note: 'no screenshot to scan', failed: false };
  }

  if (thrown !== undefined || !reply?.ok) {
    return {
      faces: reusedDetections,
      screenshotForRequest: null,
      note: 'face scan failed — screenshot withheld',
      failed: true,
    };
  }

  return {
    faces: [...reply.faces, ...reusedDetections],
    screenshotForRequest: screenshotDataUrl,
    note: `${reply.faces.length} new + ${reusedFacesCount} reused face(s) · ${reply.provider} · ${reply.inference_ms} ms`,
    failed: false,
  };
}
