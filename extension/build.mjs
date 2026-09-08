import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
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
const ORT_EP = process.env.PPVA_ORT_EP === 'webgpu' ? 'webgpu' : 'wasm';
const ORT_DIST = 'node_modules/onnxruntime-web/dist';
const ORT_ARTIFACT = ORT_EP === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded';

/**
 * Three separate bundles because the MV3 runtime contexts differ:
 *  - service worker  -> ESM (manifest declares "type": "module")
 *  - content script  -> IIFE (content scripts cannot be ES modules)
 *  - popup           -> ESM (loaded via <script type="module">)
 */
const targets = [
  { in: 'src/background/service-worker.ts', out: 'dist/background/service-worker.js', format: 'esm' },
  { in: 'src/capture/content-script.ts', out: 'dist/capture/content-script.js', format: 'iife' },
  { in: 'src/popup/popup.ts', out: 'dist/popup/popup.js', format: 'esm' },
  { in: 'src/options/options.ts', out: 'dist/options/options.js', format: 'esm' },
  { in: 'src/perception/offscreen.ts', out: 'dist/perception/offscreen.js', format: 'esm' },
];

async function copyStatic() {
  for (const dir of ['dist/popup', 'dist/options', 'dist/perception', 'dist/ort', 'dist/models']) {
    await mkdir(dir, { recursive: true });
  }
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/popup/popup.html', 'dist/popup/popup.html');
  await cp('src/popup/popup.css', 'dist/popup/popup.css');
  await cp('src/options/options.html', 'dist/options/options.html');
  await cp('src/popup/popup.css', 'dist/options/options.css');
  await cp('src/perception/offscreen.html', 'dist/perception/offscreen.html');

  // ORT loads its wasm glue and binary at runtime from ort.env.wasm.wasmPaths,
  // so both must sit in the package as real files rather than being bundled.
  for (const ext of ['.mjs', '.wasm']) {
    await cp(`${ORT_DIST}/${ORT_ARTIFACT}${ext}`, `dist/ort/${ORT_ARTIFACT}${ext}`);
  }

  if (existsSync('models/version-RFB-320.onnx')) {
    await cp('models/version-RFB-320.onnx', 'dist/models/version-RFB-320.onnx');
  } else {
    console.warn('[ppva] models/version-RFB-320.onnx is absent — face detection will be unavailable.');
    console.warn('[ppva] fetch it with: npm run fetch:model');
  }
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
  console.log('[ppva] watching… (static files are copied once; re-run to pick up html/css/manifest edits)');
} else {
  await Promise.all(
    targets.map((t) => build({ ...common, entryPoints: [t.in], outfile: t.out, format: t.format })),
  );
  await copyStatic();
  console.log(`[ppva] build complete -> extension/dist (ORT execution provider: ${ORT_EP})`);
}
