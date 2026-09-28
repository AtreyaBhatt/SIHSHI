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
 * still sees every node), and the full-frame face pass runs on every step.
 * The ONLY thing skipped is the per-region (upscaled crop) face pass of an
 * <img>/<svg>/etc. media node whose hash is unchanged since the previous step;
 * that node's previously-detected boxes are reused instead (padded by
 * REUSE_PAD_PX, never invented). <video> and <canvas> are always re-scanned
 * (their pixels change under a constant hash). A failed detection never
 * becomes remembered state (`advance` keeps the previous state).
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
  /** Always true: the full-frame face pass is never skipped. */
  full_frame_pass: true;
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
 * what it's worth, where it sits, and (for media) what image is behind it
 * and which visual effects (blur, opacity, clip) sit on it or its wrappers.
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
    n.attrs.loaded ?? '',
    n.attrs.fx ?? '',
  ].join('|');
  return fnv1a(key);
}

/**
 * True when two boxes share any area — touching edges do not count, and
 * neither does a zero-area (zero-width or zero-height) box: it has no area
 * to share with anything.
 */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  if (a[2] <= a[0] || a[3] <= a[1] || b[2] <= b[0] || b[3] <= b[1]) return false;
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
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

/** Pixels change while the node (and its hash) stays the same. */
function alwaysChanged(n: RawDomNode): boolean {
  return n.media === 'video' || n.media === 'canvas';
}

/** Bbox rounding can shift a box by up to 0.5 px; reused boxes are widened by this much per side. */
export const REUSE_PAD_PX = 2;

export function padBox(b: BBox, width: number, height: number, pad = REUSE_PAD_PX): BBox {
  return [
    Math.max(0, b[0] - pad),
    Math.max(0, b[1] - pad),
    Math.min(width, b[2] + pad),
    Math.min(height, b[3] + pad),
  ];
}

function iou(a: BBox, b: BBox): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** Drops a box whose IoU with an already-kept (earlier) box exceeds 0.8. */
export function dedupeFaces(faces: FaceBox[]): FaceBox[] {
  const kept: FaceBox[] = [];
  for (const f of faces) if (!kept.some((k) => iou(k.bbox, f.bbox) > 0.8)) kept.push(f);
  return kept;
}

export interface DeltaPlan {
  /** Media whose per-region pass must run: new, hash changed, or video/canvas. */
  changedMedia: RawDomNode[];
  /** Every non-iframe media node in this capture. */
  mediaNodes: RawDomNode[];
  /** Unpadded boxes remembered for unchanged media (pad with padBox before redacting). */
  reusedFaces: FaceBox[];
  report: DeltaReport;
  hashes: Map<string, string>;
}

export function planDelta(
  prev: StepState | null,
  nodes: RawDomNode[],
): DeltaPlan {
  const firstStep = prev === null;
  const hashes = new Map<string, string>();
  const changedPaths = new Set<string>();

  for (const n of nodes) {
    const hash = hashNode(n);
    hashes.set(n.path, hash);
    const prevHash = prev?.hashes.get(n.path);
    if (firstStep || prevHash === undefined || prevHash !== hash) changedPaths.add(n.path);
  }

  // Something disappeared entirely (a path the previous step knew about is
  // gone from this one) — conservatively re-process every media node, since a
  // removed element can uncover or otherwise change what is visible anywhere
  // on the page without any media node's own hash moving.
  const nodeRemoved = !firstStep && Array.from(prev!.hashes.keys()).some((p) => !hashes.has(p));

  const mediaNodes = nodes.filter(isMedia);
  const changedOrNewNodes = firstStep ? [] : nodes.filter((n) => changedPaths.has(n.path));
  const changedMedia = mediaNodes.filter((n) => {
    if (changedPaths.has(n.path) || alwaysChanged(n) || nodeRemoved) return true;
    // A media node whose own hash is unchanged may still sit under something
    // that changed or newly appeared this step — its pixels may no longer be
    // what the last face pass saw, so the region pass must re-run.
    return changedOrNewNodes.some((other) => other.path !== n.path && bboxIntersects(other.bbox, n.bbox));
  });
  const unchangedMedia = mediaNodes.filter((n) => !changedMedia.includes(n));

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
    full_frame_pass: true,
  };

  return { changedMedia, mediaNodes, reusedFaces, report, hashes };
}

/**
 * Builds the next step's state: `hashes` carried through unchanged, and a
 * fresh `facesByPath` built by assigning every face box in `faces` (newly
 * detected this step) and `reused` (carried over from the previous step),
 * deduplicated, to whichever of `mediaNodes` contains that face's centre point.
 */
export function nextState(
  hashes: Map<string, string>,
  mediaNodes: RawDomNode[],
  faces: FaceBox[],
  reused: FaceBox[],
): StepState {
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

  for (const f of dedupeFaces([...faces, ...reused])) assign(f);

  return { hashes, facesByPath };
}

/**
 * The state the worker keeps after a step. `faces === null` means detection
 * did not complete (no screenshot, detector error): the previous state is kept
 * unchanged, so every region that changed this step is still "changed" next step.
 */
export function advance(prev: StepState | null, plan: DeltaPlan, faces: FaceBox[] | null): StepState | null {
  return faces === null ? prev : nextState(plan.hashes, plan.mediaNodes, faces, plan.reusedFaces);
}
