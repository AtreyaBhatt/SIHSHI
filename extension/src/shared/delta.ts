/**
 * DeltaVision: what changed between one capture and the next, and which
 * face boxes can be carried forward instead of re-detected.
 *
 * Pure module — no `chrome.*`, no DOM. The worker (background/service-worker.ts)
 * is the only caller with side effects: it keeps one `StepState` per run/session
 * (keyed by the token registry's `session_id`) and feeds this module's output
 * back into the offscreen face detector and into `PayloadPreview.delta`.
 *
 * Invariant this module exists to protect: PII detection always runs on the
 * full snapshot (every node is hashed and compared, every text/DOM heuristic
 * still sees every node) — only face inference on unchanged media regions may
 * be skipped, and only because the previous, already-detected boxes for that
 * exact region are reused verbatim, never invented or widened.
 */
import type { BBox, RawDomNode } from './schema';

export interface FaceBox {
  bbox: BBox;
  confidence: number;
}

/** What a run/session remembers between one step's capture and the next. */
export interface StepState {
  /** path -> hashNode(node), for every node in the previous capture. */
  hashes: Map<string, string>;
  /** path -> the face boxes last known to sit inside that media node. */
  facesByPath: Map<string, FaceBox[]>;
}

export interface DeltaReport {
  nodes_total: number;
  nodes_changed: number;
  nodes_changed_pct: number;
  media_total: number;
  media_reprocessed: number;
  media_area_reprocessed_pct: number;
  faces_reused: number;
  first_step: boolean;
}

/** FNV-1a, 32-bit, rendered as 8 lowercase hex chars. Never the input itself — only its digest crosses this boundary. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * One node's identity for change-detection purposes: what it is, what it says,
 * what it's worth, where it sits, and (for media) what image is behind it.
 * `src_hash` is the only way an image swap at the same path/box/alt is ever
 * caught — the URL itself never enters the snapshot (see dom-snapshot.ts).
 */
export function hashNode(n: RawDomNode): string {
  const key = [
    n.tag,
    n.text ?? '',
    n.value ?? '',
    n.value_omitted ?? '',
    n.bbox.join(','),
    n.attrs.alt ?? '',
    n.media ?? '',
    n.attrs.src_hash ?? '',
  ].join('|');
  return fnv1a(key);
}

function area(n: RawDomNode): number {
  return Math.max(0, n.bbox[2] - n.bbox[0]) * Math.max(0, n.bbox[3] - n.bbox[1]);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function isMedia(n: RawDomNode): boolean {
  return n.media !== null && n.media !== 'iframe';
}

export function planDelta(
  prev: StepState | null,
  nodes: RawDomNode[],
): { changedMedia: RawDomNode[]; reusedFaces: FaceBox[]; report: DeltaReport; hashes: Map<string, string> } {
  const firstStep = prev === null;
  const hashes = new Map<string, string>();
  const changedPaths = new Set<string>();

  for (const n of nodes) {
    const hash = hashNode(n);
    hashes.set(n.path, hash);
    const prevHash = prev?.hashes.get(n.path);
    if (firstStep || prevHash === undefined || prevHash !== hash) changedPaths.add(n.path);
  }

  const mediaNodes = nodes.filter(isMedia);
  const changedMedia = mediaNodes.filter((n) => changedPaths.has(n.path));
  const unchangedMedia = mediaNodes.filter((n) => !changedPaths.has(n.path));

  const reusedFaces: FaceBox[] = [];
  if (prev) {
    for (const n of unchangedMedia) {
      const boxes = prev.facesByPath.get(n.path);
      if (boxes) reusedFaces.push(...boxes);
    }
  }

  const totalMediaArea = mediaNodes.reduce((sum, n) => sum + area(n), 0);
  const changedMediaArea = changedMedia.reduce((sum, n) => sum + area(n), 0);

  const report: DeltaReport = {
    nodes_total: nodes.length,
    nodes_changed: changedPaths.size,
    nodes_changed_pct: nodes.length > 0 ? round1((changedPaths.size / nodes.length) * 100) : 0,
    media_total: mediaNodes.length,
    media_reprocessed: changedMedia.length,
    media_area_reprocessed_pct: totalMediaArea > 0 ? round1((changedMediaArea / totalMediaArea) * 100) : 0,
    faces_reused: reusedFaces.length,
    first_step: firstStep,
  };

  return { changedMedia, reusedFaces, report, hashes };
}

/**
 * Builds the next step's state: `hashes` carried through unchanged, and a
 * fresh `facesByPath` built by assigning every face box in `faces` (newly
 * detected this step) and `reused` (carried over from the previous step) to
 * whichever of `mediaNodes` contains that face's centre point. `prev` is not
 * read here — reuse already happened in `planDelta`; it is accepted only to
 * keep the two functions' signatures symmetric for callers that thread one
 * state object through both.
 */
export function nextState(
  hashes: Map<string, string>,
  mediaNodes: RawDomNode[],
  faces: FaceBox[],
  reused: FaceBox[],
  prev: StepState | null,
): StepState {
  void prev;
  const facesByPath = new Map<string, FaceBox[]>();

  const assign = (face: FaceBox) => {
    const cx = (face.bbox[0] + face.bbox[2]) / 2;
    const cy = (face.bbox[1] + face.bbox[3]) / 2;
    for (const node of mediaNodes) {
      const [x1, y1, x2, y2] = node.bbox;
      if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
        const list = facesByPath.get(node.path);
        if (list) list.push(face);
        else facesByPath.set(node.path, [face]);
        return;
      }
    }
  };

  for (const f of faces) assign(f);
  for (const f of reused) assign(f);

  return { hashes, facesByPath };
}
