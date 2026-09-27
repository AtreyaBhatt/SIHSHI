import { build, context } from 'esbuild';
import {
  cp, mkdir, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/**
 * Which ONNX Runtime wasm artifact ships.
 *
 *   wasm    (default) ort-wasm-simd-threaded.wasm       13.3 MB — WASM SIMD only
 *   webgpu            ort-wasm-simd-threaded.jsep.wasm  26.5 MB — WebGPU + WASM
 *
 * PRD §8 budgets under 20 MB of client payload, so the default stays inside it.
 * The runtime code requests WebGPU either way and falls back to WASM, which is
 * exactly what the smaller artifact makes it do.
 */
const ORT_EP = process.env.ATHENA_ORT_EP === 'webgpu' ? 'webgpu' : 'wasm';
const ORT_DIST = 'node_modules/onnxruntime-web/dist';
const ORT_ARTIFACT = ORT_EP === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded';

/**
 * Three separate bundles because the MV3 runtime contexts differ:
 *  - service worker  -> ESM (manifest declares "type": "module")
 *  - content script  -> IIFE (content scripts cannot be ES modules)
 *  - side panel      -> ESM (loaded via <script type="module">)
 */
const targets = [
  { in: 'src/background/service-worker.ts', out: 'dist/background/service-worker.js', format: 'esm' },
  { in: 'src/capture/content-script.ts', out: 'dist/capture/content-script.js', format: 'iife' },
  { in: 'src/sidebar/sidebar.ts', out: 'dist/sidebar/sidebar.js', format: 'esm' },
  { in: 'src/options/options.ts', out: 'dist/options/options.js', format: 'esm' },
  { in: 'src/perception/offscreen.ts', out: 'dist/perception/offscreen.js', format: 'esm' },
  { in: 'src/viewer/viewer.ts', out: 'dist/viewer/viewer.js', format: 'esm' },
];

async function copyStatic() {
  for (const dir of ['dist/sidebar', 'dist/options', 'dist/perception', 'dist/viewer', 'dist/assets', 'dist/ort', 'dist/models']) {
    await mkdir(dir, { recursive: true });
  }
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/sidebar/sidebar.html', 'dist/sidebar/sidebar.html');
  await cp('src/sidebar/sidebar.css', 'dist/sidebar/sidebar.css');
  await cp('src/options/options.html', 'dist/options/options.html');
  await cp('src/options/options.css', 'dist/options/options.css');
  await cp('src/assets', 'dist/assets', { recursive: true });
  await cp('src/perception/offscreen.html', 'dist/perception/offscreen.html');
  await cp('src/viewer/viewer.html', 'dist/viewer/viewer.html');
  await cp('src/viewer/viewer.css', 'dist/viewer/viewer.css');

  // ORT loads its wasm glue and binary at runtime from ort.env.wasm.wasmPaths,
  // so both must sit in the package as real files rather than being bundled.
  for (const ext of ['.mjs', '.wasm']) {
    await cp(`${ORT_DIST}/${ORT_ARTIFACT}${ext}`, `dist/ort/${ORT_ARTIFACT}${ext}`);
  }

  if (!existsSync('models/version-RFB-320.onnx')) {
    throw new Error(
      '[athena] missing models/version-RFB-320.onnx — run "npm run fetch:model" before building the extension.',
    );
  }
  await cp('models/version-RFB-320.onnx', 'dist/models/version-RFB-320.onnx');

  await writeBenchmark();
}

/**
 * Copies the eval corpus's own measured numbers into the package so the
 * metrics card can show them with a date and corpus size, without recomputing
 * anything at build time. Every field here is either read straight out of
 * `eval/results/metrics.json` (the eval scripts already wrote it) or, for
 * latency, a plain p50/p95 over the raw per-run milliseconds in
 * `eval/results/latency.json` — a percentile of real measurements, not a
 * fabricated number. Missing corpus output writes `{ missing: true }` rather
 * than failing the build: the extension must still work for a checkout that
 * has not run the eval.
 */
const METRICS_PATH = '../eval/results/metrics.json';
const LATENCY_PATH = '../eval/results/latency.json';
const LATENCY_STAGES = ['capture_ms', 'screenshot_ms', 'perception_ms', 'redaction_ms', 'network_ms', 'execute_ms'];

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function writeBenchmark() {
  if (!existsSync(METRICS_PATH)) {
    await writeFile('dist/assets/benchmark.json', JSON.stringify({ missing: true }, null, 2));
    return;
  }
  const metrics = JSON.parse(await readFile(METRICS_PATH, 'utf8'));
  const generatedAt = (await stat(METRICS_PATH)).mtime.toISOString();

  let latency = null;
  if (existsSync(LATENCY_PATH)) {
    const raw = JSON.parse(await readFile(LATENCY_PATH, 'utf8'));
    const runs = raw.runs ?? [];
    latency = Object.fromEntries(LATENCY_STAGES.map((stage) => {
      const values = runs.map((r) => r[stage]).filter((v) => typeof v === 'number');
      return [stage, { p50: percentile(values, 50), p95: percentile(values, 95) }];
    }));
  }

  const benchmark = {
    generated_at: generatedAt,
    screens: metrics.screens,
    items: metrics.labelled_items,
    detection: {
      overall: metrics.detection?.overall ?? null,
      tier1: metrics.detection?.by_tier?.['1'] ?? null,
      tier2: metrics.detection?.by_tier?.['2'] ?? null,
    },
    // Only tier1 IoU-based redaction precision is computed by run_eval.py
    // today; tier2/overall stay null rather than being invented here.
    redaction_precision: {
      tier1: metrics.metrics?.tier1_redaction_precision ?? null,
      tier2: null,
      overall: null,
    },
    latency,
  };
  await writeFile('dist/assets/benchmark.json', JSON.stringify(benchmark, null, 2));
}

const common = {
  bundle: true,
  target: 'chrome116',
  logLevel: 'info',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  // Selects ORT's external-wasm entry points. Without it the default export
  // resolves to a bundle with 26 MB of wasm inlined as base64.
  conditions: ['onnxruntime-web-use-extern-wasm'],
  // The wasm-only build has no WebGPU support compiled in; aliasing here keeps
  // one import path in the source.
  alias: ORT_EP === 'webgpu' ? {} : { 'onnxruntime-web': 'onnxruntime-web/wasm' },
};

await rm('dist', { recursive: true, force: true });

if (watch) {
  const ctxs = await Promise.all(
    targets.map((t) => context({ ...common, entryPoints: [t.in], outfile: t.out, format: t.format })),
  );
  await copyStatic();
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[athena] watching… (static files are copied once; re-run to pick up html/css/manifest edits)');
} else {
  await Promise.all(
    targets.map((t) => build({ ...common, entryPoints: [t.in], outfile: t.out, format: t.format })),
  );
  await copyStatic();
  console.log(`[athena] build complete -> extension/dist (ORT execution provider: ${ORT_EP})`);
}
