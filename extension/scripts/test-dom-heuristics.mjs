/**
 * DOM/attribute heuristics as pure functions — no DOM, no Chrome. Covers the
 * QR media rule's token matching directly, since fixtures.spec.mjs only
 * asserts the aggregate manifest (a 'frame' type present somewhere), not this
 * rule's regex in isolation.
 *
 * Usage:  npm run test:dom-heuristics
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-dom-heuristics-'));
await build({
  entryPoints: ['src/pii-detection/dom-heuristics.ts'],
  outfile: join(temp, 'dom-heuristics.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error',
});
const { MEDIA_RULES } = await import(`file://${join(temp, 'dom-heuristics.mjs')}`);
await rm(temp, { recursive: true, force: true }).catch(() => {});

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.error(`  FAIL ${msg}`); } };

const qrRule = MEDIA_RULES.find((r) => r.detector === 'dom:qr');
check(!!qrRule, 'dom:qr rule exists in MEDIA_RULES');

/** A minimal RawDomNode stand-in — only the fields the rule reads. */
const node = (attrs) => ({ attrs: { alt: null, title: null, id: null, class: null, src_file: null, ...attrs } });

const positive = [
  ['id="qrcode"', node({ id: 'qrcode' })],
  ['class="qrcode"', node({ class: 'qrcode' })],
  ['id="qr-code"', node({ id: 'qr-code' })],
  ['id="qr_code"', node({ id: 'qr_code' })],
  ['alt="UPI QR"', node({ alt: 'UPI QR' })],
  ['src_file="scan-to-pay.png"', node({ src_file: 'scan-to-pay.png' })],
];
for (const [label, n] of positive) {
  check(qrRule.test(n, ''), `${label} matches dom:qr`);
}

const negative = [
  ['id="square"', node({ id: 'square' })],
  ['class="inquiry"', node({ class: 'inquiry' })],
  ['id="sqrt"', node({ id: 'sqrt' })],
];
for (const [label, n] of negative) {
  check(!qrRule.test(n, ''), `${label} does NOT match dom:qr`);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
