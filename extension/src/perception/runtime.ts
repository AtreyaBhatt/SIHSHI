/**
 * ONNX Runtime Web session management.
 *
 * CLAUDE.md requires the WebGPU execution provider with a WASM SIMD fallback,
 * and requires checking `navigator.gpu` rather than assuming it. Both happen
 * here: the EP list is built from what the machine actually reports, and ORT
 * itself falls back down the list if a provider fails to initialise.
 *
 * WHICH ARTIFACT SHIPS IS A BUILD FLAG, and it is a real trade-off rather than a
 * detail. ORT's WebGPU-capable wasm ("jsep") is 26.5 MB on disk; the WASM-SIMD-
 * only binary is 13.3 MB. PRD §8 budgets under 20 MB. The build therefore
 * defaults to the WASM binary and stays inside that budget, and
 * `ATHENA_ORT_EP=webgpu npm run build` ships the larger one. The code below is
 * identical either way — with the smaller artifact, requesting WebGPU simply
 * falls through to WASM, which is the documented fallback behaving as intended.
 *
 * For a 320x240 single-shot detector the two are close in practice: WebGPU's
 * win is real on large batched work and largely eaten by shader compilation on
 * a one-shot inference.
 */
import * as ort from 'onnxruntime-web';

export type ExecutionProviderName = 'webgpu' | 'wasm';

export interface RuntimeInfo {
  /** The provider we asked ORT for first. */
  provider: ExecutionProviderName;
  init_ms: number;
  model_bytes: number;
}

let cached: Promise<{ session: ort.InferenceSession; info: RuntimeInfo }> | null = null;

/** Must be called before the first session. `wasmBaseUrl` needs a trailing slash. */
export function configureRuntime(wasmBaseUrl: string): void {
  ort.env.wasm.wasmPaths = wasmBaseUrl;
  // No worker spawning: an offscreen document has no reliable path to
  // cross-origin-isolated SharedArrayBuffer, and threads buy little on a model
  // this small.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
}

async function availableProviders(): Promise<ExecutionProviderName[]> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } })?.gpu;
  if (gpu) {
    try {
      if (await gpu.requestAdapter()) return ['webgpu', 'wasm'];
    } catch {
      /* adapter request can throw on a blocklisted driver — fall through */
    }
  }
  return ['wasm'];
}

export async function getSession(
  modelUrl: string,
  wasmBaseUrl: string,
): Promise<{ session: ort.InferenceSession; info: RuntimeInfo }> {
  if (cached) return cached;

  cached = (async () => {
    const started = performance.now();
    configureRuntime(wasmBaseUrl);

    const response = await fetch(modelUrl); // extension-local URL, never the network
    if (!response.ok) throw new Error(`Model not found at ${modelUrl} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    const providers = await availableProviders();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });

    return {
      session,
      info: {
        provider: providers[0]!,
        init_ms: Math.round((performance.now() - started) * 100) / 100,
        model_bytes: bytes.byteLength,
      },
    };
  })();

  return cached;
}

export function resetSession(): void {
  cached = null;
}
