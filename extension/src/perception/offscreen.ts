/**
 * Host for local ML inference.
 *
 * Runs in an offscreen document rather than the service worker or the content
 * script. The content script is out because it inherits the visited page's CSP,
 * and a great many sites forbid `wasm-unsafe-eval` — face detection that works
 * on the demo page and silently fails on a bank's is worse than none. The
 * service worker is out because wasm and WebGPU support there is uneven across
 * Chrome versions. An offscreen document is an ordinary extension page: our own
 * CSP, our own origin, a real canvas, and not the visited page's main thread.
 */
import { detectFaces, type FaceDetection } from './face-detect';
import type { BBox } from '../shared/schema';

const MODEL_URL = chrome.runtime.getURL('models/version-RFB-320.onnx');
const WASM_BASE_URL = chrome.runtime.getURL('ort/');

export interface DetectFacesRequest {
  type: 'ppva:detect-faces';
  screenshot_data_url: string;
  /** Media-element boxes in viewport CSS px; each gets a full-resolution pass. */
  regions: BBox[];
  /** Viewport CSS px per screenshot device px. */
  viewport_width: number;
  threshold?: number;
}

export interface DetectFacesReply {
  ok: boolean;
  faces: FaceDetection[];
  provider?: string;
  inference_ms?: number;
  init_ms?: number;
  error?: string;
}

/** No fetch: keeps the extension's only network call the one in agent-client.ts. */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = /:(.*?);/.exec(dataUrl.slice(0, comma))?.[1] ?? 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function handle(message: DetectFacesRequest): Promise<DetectFacesReply> {
  const bitmap = await createImageBitmap(dataUrlToBlob(message.screenshot_data_url));
  try {
    // The screenshot is in device pixels, the boxes in CSS pixels. Convert the
    // regions into the image's own space, and scale results back on the way out.
    const cssPerDevice = message.viewport_width > 0 ? message.viewport_width / bitmap.width : 1;
    const devicePerCss = cssPerDevice === 0 ? 1 : 1 / cssPerDevice;
    const regions: BBox[] = message.regions
      .map((b): BBox => [
        Math.max(0, Math.round(b[0] * devicePerCss)),
        Math.max(0, Math.round(b[1] * devicePerCss)),
        Math.min(bitmap.width, Math.round(b[2] * devicePerCss)),
        Math.min(bitmap.height, Math.round(b[3] * devicePerCss)),
      ])
      // Anything smaller than the model's own receptive scale adds an inference
      // without adding recall.
      .filter((b) => b[2] - b[0] >= 32 && b[3] - b[1] >= 32);

    const result = await detectFaces(bitmap, {
      modelUrl: MODEL_URL,
      wasmBaseUrl: WASM_BASE_URL,
      regions,
      scale: cssPerDevice,
      ...(message.threshold !== undefined ? { threshold: message.threshold } : {}),
    });

    return {
      ok: true,
      faces: result.faces,
      provider: result.runtime.provider,
      inference_ms: result.inference_ms,
      init_ms: result.runtime.init_ms,
    };
  } finally {
    bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((message: DetectFacesRequest, _sender, sendResponse) => {
  if (message?.type !== 'ppva:detect-faces') return false;
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, faces: [], error: err instanceof Error ? err.message : String(err) }));
  return true;
});
