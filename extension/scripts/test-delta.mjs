/**
 * shared/delta.ts as a pure module — no DOM, no Chrome, no browser harness.
 * Node hashing, change percentages, and face-box reuse across a two- or
 * three-step run.
 *
 * Usage:  npm run test:delta
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-delta-'));
await build({
  entryPoints: ['src/shared/delta.ts'],
  outfile: join(temp, 'delta.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error',
});
const { hashNode, planDelta, nextState, fnv1a } = await import(`file://${join(temp, 'delta.mjs')}`);
await rm(temp, { recursive: true, force: true }).catch(() => {});

let failures = 0;
const check = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.error(`  FAIL ${msg}`); } };

/** A minimal RawDomNode stand-in — only the fields hashNode/planDelta read. */
function node(path, over = {}) {
  return {
    path, tag: 'div', role: null, label: null, text: null, context_label: null,
    value: null, value_omitted: null, input_type: null,
    attrs: {
      id: null, name: null, autocomplete: null, placeholder: null, aria_label: null,
      alt: null, title: null, inputmode: null, maxlength: null, class: null,
      src_file: null, src_hash: null,
    },
    bbox: [0, 0, 100, 100], interactive: false, media: null, group_id: null,
    ...over,
  };
}

const img = (path, over = {}) => node(path, { tag: 'img', media: 'img', bbox: [0, 0, 100, 100], ...over });

console.log('no chrome.* import:');
const { readFileSync } = await import('node:fs');
const src = readFileSync('src/shared/delta.ts', 'utf8');
check(!/\bchrome\.(runtime|storage|tabs|scripting|offscreen|windows|action)\b/.test(src), 'src/shared/delta.ts contains no chrome.* API reference');

console.log('\n(a) first step:');
{
  const nodes = [node('p#a', { text: 'hi' }), img('img#one')];
  const { changedMedia, reusedFaces, report } = planDelta(null, nodes);
  check(report.first_step === true, 'first_step is true');
  check(report.nodes_changed === 2 && report.nodes_total === 2, `all nodes changed (${report.nodes_changed}/${report.nodes_total})`);
  check(report.nodes_changed_pct === 100, `nodes_changed_pct is 100 (got ${report.nodes_changed_pct})`);
  check(report.media_reprocessed === 1 && report.media_total === 1, 'the one image is reprocessed');
  check(report.media_area_reprocessed_pct === 100, `media_area_reprocessed_pct is 100 (got ${report.media_area_reprocessed_pct})`);
  check(changedMedia.length === 1 && changedMedia[0].path === 'img#one', 'changedMedia contains the image');
  check(reusedFaces.length === 0, 'no faces to reuse on the first step');
}

console.log('\n(b) identical second step:');
{
  const nodes = [node('p#a', { text: 'hi' }), img('img#one')];
  const step1 = planDelta(null, nodes);
  const state1 = nextState(step1.hashes, [nodes[1]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], [], null);
  const step2 = planDelta(state1, nodes);
  check(step2.report.first_step === false, 'first_step is false on the second step');
  check(step2.report.nodes_changed === 0, `0 nodes changed (got ${step2.report.nodes_changed})`);
  check(step2.report.media_reprocessed === 0, `media_reprocessed is 0 (got ${step2.report.media_reprocessed})`);
  check(step2.reusedFaces.length === 1, `the one known face is reused (got ${step2.reusedFaces.length})`);
  check(step2.report.faces_reused === 1, 'report.faces_reused matches');
}

console.log('\n(c) one text node changes, media untouched:');
{
  const before = [node('p#a', { text: 'hi' }), img('img#one')];
  const state1 = (() => {
    const p = planDelta(null, before);
    return nextState(p.hashes, [before[1]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], [], null);
  })();
  const after = [node('p#a', { text: 'bye' }), img('img#one')];
  const step2 = planDelta(state1, after);
  check(step2.report.nodes_changed === 1, `exactly 1 node changed (got ${step2.report.nodes_changed})`);
  check(step2.changedMedia.length === 0, 'no media reprocessed');
  check(step2.reusedFaces.length === 1, 'the image face is still reused');
}

console.log('\n(d) one image src_hash changes, the other is reused:');
{
  const before = [
    img('img#one', { bbox: [0, 0, 100, 100], attrs: { ...node('x').attrs, src_hash: 'aaaaaaaa' } }),
    img('img#two', { bbox: [100, 0, 200, 100], attrs: { ...node('x').attrs, src_hash: 'bbbbbbbb' } }),
  ];
  const p1 = planDelta(null, before);
  const state1 = nextState(
    p1.hashes,
    before,
    [
      { bbox: [10, 10, 30, 30], confidence: 0.9 }, // centre (20,20) -> img#one
      { bbox: [110, 10, 130, 30], confidence: 0.8 }, // centre (120,20) -> img#two
    ],
    [],
    null,
  );
  const after = [
    img('img#one', { bbox: [0, 0, 100, 100], attrs: { ...node('x').attrs, src_hash: 'cccccccc' } }), // swapped image, same path/box/alt
    img('img#two', { bbox: [100, 0, 200, 100], attrs: { ...node('x').attrs, src_hash: 'bbbbbbbb' } }),
  ];
  const step2 = planDelta(state1, after);
  check(step2.changedMedia.length === 1 && step2.changedMedia[0].path === 'img#one', 'only img#one is reprocessed');
  check(step2.reusedFaces.length === 1, `only img#two's face is reused (got ${step2.reusedFaces.length})`);
  check(
    step2.reusedFaces.every((f) => f.bbox[0] === 110),
    "the reused face is img#two's box, not img#one's stale one",
  );
}

console.log('\n(e) a node bbox moves:');
{
  const before = [node('p#a', { text: 'hi', bbox: [0, 0, 50, 20] })];
  const p1 = planDelta(null, before);
  const state1 = nextState(p1.hashes, [], [], [], null);
  const after = [node('p#a', { text: 'hi', bbox: [0, 40, 50, 60] })];
  const step2 = planDelta(state1, after);
  check(step2.report.nodes_changed === 1, `moved node counts as changed (got ${step2.report.nodes_changed})`);
}

console.log('\n(f) a face is assigned to the media node containing its centre:');
{
  const mediaNodes = [
    img('img#left', { bbox: [0, 0, 100, 100] }),
    img('img#right', { bbox: [200, 0, 300, 100] }),
  ];
  const faces = [
    { bbox: [10, 10, 30, 30], confidence: 0.9 }, // centre (20,20) -> img#left
    { bbox: [210, 10, 230, 30], confidence: 0.8 }, // centre (220,20) -> img#right
  ];
  const state = nextState(new Map(), mediaNodes, faces, [], null);
  check(state.facesByPath.get('img#left')?.length === 1, 'left face assigned to img#left');
  check(state.facesByPath.get('img#right')?.length === 1, 'right face assigned to img#right');
}

console.log('\n(g) percentages rounded to one decimal, never NaN with zero media:');
{
  const nodes = [node('p#a', { text: 'hi' }), node('p#b', { text: 'one' }), node('p#c', { text: 'two' })];
  const p1 = planDelta(null, nodes);
  check(p1.report.media_total === 0, 'no media nodes');
  check(p1.report.media_area_reprocessed_pct === 0, `media_area_reprocessed_pct is 0, not NaN (got ${p1.report.media_area_reprocessed_pct})`);
  check(!Number.isNaN(p1.report.nodes_changed_pct), 'nodes_changed_pct is not NaN');

  // One-decimal rounding: 1 of 3 nodes changed -> 33.3%, not 33.333...
  const state1 = nextState(p1.hashes, [], [], [], null);
  const after = [node('p#a', { text: 'hi' }), node('p#b', { text: 'CHANGED' }), node('p#c', { text: 'two' })];
  const step2 = planDelta(state1, after);
  check(step2.report.nodes_changed_pct === 33.3, `rounded to one decimal (got ${step2.report.nodes_changed_pct})`);
}

console.log('\nfnv1a:');
check(typeof fnv1a === 'function', 'fnv1a is exported');
check(/^[0-9a-f]{8}$/.test(fnv1a('https://example.com/photo.jpg')), 'fnv1a returns 8 lowercase hex chars');
check(fnv1a('a') !== fnv1a('b'), 'different inputs hash differently');

console.log('\nhashNode differs on tag/text/value/bbox/alt/media/src_hash:');
{
  const base = node('p#a', { tag: 'p', text: 'hi' });
  check(hashNode(base) === hashNode(node('p#a', { tag: 'p', text: 'hi' })), 'identical nodes hash identically');
  check(hashNode(base) !== hashNode(node('p#a', { tag: 'p', text: 'bye' })), 'text change flips the hash');
  check(hashNode(base) !== hashNode({ ...base, bbox: [1, 1, 2, 2] }), 'bbox change flips the hash');
  const withSrc = img('img#one', { attrs: { ...img('img#one').attrs, src_hash: 'aaaaaaaa' } });
  const swapped = img('img#one', { attrs: { ...img('img#one').attrs, src_hash: 'bbbbbbbb' } });
  check(hashNode(withSrc) !== hashNode(swapped), 'src_hash change flips the hash even with identical box/alt');
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
