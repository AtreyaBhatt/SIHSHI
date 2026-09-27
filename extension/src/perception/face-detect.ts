/**
 * Face detection (PRD §6.2.3 step 4) — the last and most expensive stage of the
 * cascade, and the only one that looks at pixels.
 *
 * Model: UltraFace `version-RFB-320` from the ONNX Model Zoo. PRD §6.2.3 names
 * BlazeFace "or an ONNX-exported equivalent"; BlazeFace's canonical distribution
 * is TF.js, and CLAUDE.md requires ONNX Runtime Web, so the ONNX-native
 * equivalent is what ships. 1.2 MB, same job, comparable accuracy at this size.
 * Provenance and checksum are in extension/models/README.md.
 *
 * SCOPE, STATED HONESTLY: the full-frame pass is 320x240, so a face occupying a
 * small fraction of a 1280-wide capture lands on very few input pixels and can
 * be missed. That is why `regions` exists — pass the media-element boxes the
 * snapshot already identified and each gets its own full-resolution pass, at the
 * cost of one inference apiece. Faces are Tier 1, so a miss is the worst failure
 * mode this project has; the recall/cost trade belongs in the eval writeup, not
 * in a footnote.
 */
import * as ort from 'onnxruntime-web';
import type { BBox } from '../shared/schema';
import { getSession, type RuntimeInfo } from './runtime';

const INPUT_WIDTH = 320;
const INPUT_HEIGHT = 240;

/** Conservative by design (PRD §9): a false face box costs a blurred rectangle. */
export const DEFAULT_FACE_THRESHOLD = 0.6;
const NMS_IOU = 0.3;

export interface FaceDetection {
  /** Viewport CSS pixels, matching every other bbox in the system. */
  bbox: BBox;
  score: number;
}

export interface FaceDetectionResult {
  faces: FaceDetection[];
  runtime: RuntimeInfo;
  /** session.run() only. */
  inference_ms: number;
  /**
   * Resize, pixel read and RGB planar conversion. Split out because the two are
   * worth telling apart when tuning: measured at ~1 ms against ~14 ms of
   * inference on a 1280x713 frame, so the model is the cost and preprocessing is
   * noise. (An earlier reading that made preprocessing look dominant was the
   * benchmark re-creating the ONNX session inside the measured window.)
   */
  preprocess_ms: number;
}

export type ImageSource = ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLImageElement;

/** UltraFace expects RGB planar, (x - 127) / 128. */
function toTensorData(source: ImageSource): Float32Array {
  const canvas = new OffscreenCanvas(INPUT_WIDTH, INPUT_HEIGHT);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D context unavailable for preprocessing');
  context.drawImage(source as CanvasImageSource, 0, 0, INPUT_WIDTH, INPUT_HEIGHT);
  const { data } = context.getImageData(0, 0, INPUT_WIDTH, INPUT_HEIGHT);

  const plane = INPUT_WIDTH * INPUT_HEIGHT;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    out[i] = (data[i * 4]! - 127) / 128;
    out[plane + i] = (data[i * 4 + 1]! - 127) / 128;
    out[plane * 2 + i] = (data[i * 4 + 2]! - 127) / 128;
  }
  return out;
}

function iou(a: BBox, b: BBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap === 0) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return overlap / (areaA + areaB - overlap);
}

function nonMaxSuppression(candidates: FaceDetection[]): FaceDetection[] {
  const kept: FaceDetection[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => iou(k.bbox, candidate.bbox) < NMS_IOU)) kept.push(candidate);
  }
  return kept;
}

/**
 * `scores` is [1, 4420, 2] with index 1 the face probability; `boxes` is
 * [1, 4420, 4] already decoded to normalised x1,y1,x2,y2 — the model does the
 * anchor arithmetic, so there is none to reimplement here.
 */
function decode(
  scores: Float32Array,
  boxes: Float32Array,
  threshold: number,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
): FaceDetection[] {
  const found: FaceDetection[] = [];
  const count = scores.length / 2;
  for (let i = 0; i < count; i++) {
    const score = scores[i * 2 + 1]!;
    if (score < threshold) continue;
    found.push({
      score: Math.round(score * 1000) / 1000,
      bbox: [
        Math.round(offsetX + boxes[i * 4]! * scaleX),
        Math.round(offsetY + boxes[i * 4 + 1]! * scaleY),
        Math.round(offsetX + boxes[i * 4 + 2]! * scaleX),
        Math.round(offsetY + boxes[i * 4 + 3]! * scaleY),
      ],
    });
  }
  return nonMaxSuppression(found);
}

export interface DetectOptions {
  modelUrl: string;
  wasmBaseUrl: string;
  threshold?: number;
  /**
   * Sub-rectangles to scan in addition to the full frame, in the source image's
   * own pixel coordinates. Pass the snapshot's media-element boxes to recover
   * small faces the full-frame pass cannot resolve.
   */
  regions?: BBox[];
  /** Maps source-image pixels to viewport CSS pixels. 1 when they are the same. */
  scale?: number;
}

async function runOne(
  source: ImageSource,
  crop: BBox | null,
  options: DetectOptions,
): Promise<{ faces: FaceDetection[]; inference_ms: number; preprocess_ms: number; runtime: RuntimeInfo }> {
  const { session, info } = await getSession(options.modelUrl, options.wasmBaseUrl);

  let input: ImageSource = source;
  let offsetX = 0;
  let offsetY = 0;
  let regionWidth = (source as { width: number }).width;
  let regionHeight = (source as { height: number }).height;

  if (crop) {
    const [x1, y1, x2, y2] = crop;
    regionWidth = x2 - x1;
    regionHeight = y2 - y1;
    const cropped = new OffscreenCanvas(regionWidth, regionHeight);
    cropped
      .getContext('2d')!
      .drawImage(source as CanvasImageSource, x1, y1, regionWidth, regionHeight, 0, 0, regionWidth, regionHeight);
    input = cropped;
    offsetX = x1;
    offsetY = y1;
  }

  const preprocessStarted = performance.now();
  const tensor = new ort.Tensor('float32', toTensorData(input), [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);
  const preprocessMs = Math.round((performance.now() - preprocessStarted) * 100) / 100;

  const started = performance.now();
  const output = await session.run({ input: tensor });
  const inferenceMs = Math.round((performance.now() - started) * 100) / 100;

  const scale = options.scale ?? 1;
  const faces = decode(
    output.scores!.data as Float32Array,
    output.boxes!.data as Float32Array,
    options.threshold ?? DEFAULT_FACE_THRESHOLD,
    regionWidth * scale,
    regionHeight * scale,
    offsetX * scale,
    offsetY * scale,
  );
  return { faces, inference_ms: inferenceMs, preprocess_ms: preprocessMs, runtime: info };
}

export async function detectFaces(source: ImageSource, options: DetectOptions): Promise<FaceDetectionResult> {
  const passes: (BBox | null)[] = [null, ...(options.regions ?? [])];
  const all: FaceDetection[] = [];
  let totalMs = 0;
  let preprocessMs = 0;
  let runtime: RuntimeInfo | null = null;

  for (const crop of passes) {
    const result = await runOne(source, crop, options);
    all.push(...result.faces);
    totalMs += result.inference_ms;
    preprocessMs += result.preprocess_ms;
    runtime = result.runtime;
  }

  return {
    // Region passes overlap the full-frame pass, so the same face can be found
    // twice at slightly different coordinates — suppress across passes too.
    faces: nonMaxSuppression(all),
    inference_ms: Math.round(totalMs * 100) / 100,
    preprocess_ms: Math.round(preprocessMs * 100) / 100,
    runtime: runtime!,
  };
}
