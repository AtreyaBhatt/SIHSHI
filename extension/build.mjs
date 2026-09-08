import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

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
];

async function copyStatic() {
  await mkdir('dist/popup', { recursive: true });
  await mkdir('dist/options', { recursive: true });
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/popup/popup.html', 'dist/popup/popup.html');
  await cp('src/popup/popup.css', 'dist/popup/popup.css');
  await cp('src/options/options.html', 'dist/options/options.html');
  await cp('src/popup/popup.css', 'dist/options/options.css');
}

const common = {
  bundle: true,
  target: 'chrome116',
  logLevel: 'info',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
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
  console.log('[ppva] build complete -> extension/dist');
}
