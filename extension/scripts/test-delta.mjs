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
const { hashNode, planDelta, nextState, advance, dedupeFaces, padBox, fnv1a, bboxIntersects } = await import(`file://${join(temp, 'delta.mjs')}`);

await build({
  entryPoints: ['src/shared/face-outcome.ts'],
  outfile: join(temp, 'face-outcome.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error',
});
const { resolveFaceOutcome } = await import(`file://${join(temp, 'face-outcome.mjs')}`);

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
  const state1 = nextState(step1.hashes, [nodes[1]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], []);
  const step2 = planDelta(state1, nodes);
  check(step2.report.first_step === false, 'first_step is false on the second step');
  check(step2.report.nodes_changed === 0, `0 nodes changed (got ${step2.report.nodes_changed})`);
  check(step2.report.media_reprocessed === 0, `media_reprocessed is 0 (got ${step2.report.media_reprocessed})`);
  check(step2.reusedFaces.length === 1, `the one known face is reused (got ${step2.reusedFaces.length})`);
  check(step2.report.faces_reused === 1, 'report.faces_reused matches');
}

console.log('\n(c) one text node changes, media untouched:');
{
  const before = [node('p#a', { text: 'hi', bbox: [200, 200, 250, 220] }), img('img#one')];
  const state1 = (() => {
    const p = planDelta(null, before);
    return nextState(p.hashes, [before[1]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], []);
  })();
  const after = [node('p#a', { text: 'bye', bbox: [200, 200, 250, 220] }), img('img#one')];
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

console.log('\n(d2) a blur is removed from a photo (only fx changes):');
{
  const before = [img('img#one', { bbox: [0, 0, 100, 100], attrs: { ...node('x').attrs, src_hash: 'aaaaaaaa', fx: '11111111' } })];
  const state1 = nextState(planDelta(null, before).hashes, before, [], []);
  const after = [img('img#one', { bbox: [0, 0, 100, 100], attrs: { ...node('x').attrs, src_hash: 'aaaaaaaa', fx: '22222222' } })];
  const step2 = planDelta(state1, after);
  check(step2.changedMedia.length === 1 && step2.changedMedia[0].path === 'img#one', 'the un-blurred image is reprocessed');
}

console.log('\n(e) a node bbox moves:');
{
  const before = [node('p#a', { text: 'hi', bbox: [0, 0, 50, 20] })];
  const p1 = planDelta(null, before);
  const state1 = nextState(p1.hashes, [], [], []);
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
  const state = nextState(new Map(), mediaNodes, faces, []);
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
  const state1 = nextState(p1.hashes, [], [], []);
  const after = [node('p#a', { text: 'hi' }), node('p#b', { text: 'CHANGED' }), node('p#c', { text: 'two' })];
  const step2 = planDelta(state1, after);
  check(step2.report.nodes_changed_pct === 33.3, `rounded to one decimal (got ${step2.report.nodes_changed_pct})`);
}

console.log('\n(K1) a face outside all media is not lost — full-frame pass every step:');
{
  const nodes = [node('p#a', { text: 'hi' }), img('img#one')];
  const p1 = planDelta(null, nodes);
  // face at (500,500) lies outside img#one: stored nowhere, so it must be re-found by the full-frame pass
  const s1 = advance(null, p1, [{ bbox: [480, 480, 520, 520], confidence: 0.9 }]);
  check(s1.facesByPath.size === 0, 'the off-media face is not stored under any path');
  const p2 = planDelta(s1, nodes);
  check(p2.report.full_frame_pass === true, 'step 2 report.full_frame_pass is true');
  check(p1.report.full_frame_pass === true, 'step 1 report.full_frame_pass is true');
  check(p2.changedMedia.length === 0, 'unchanged img#one has its region pass skipped (only that is skipped)');
}

console.log('\n(K3) video and canvas are always re-scanned, never reused:');
{
  const nodes = [
    node('video#v', { tag: 'video', media: 'video', bbox: [0, 0, 100, 100] }),
    node('canvas#c', { tag: 'canvas', media: 'canvas', bbox: [200, 0, 300, 100] }),
  ];
  const p1 = planDelta(null, nodes);
  const s1 = advance(null, p1, [
    { bbox: [10, 10, 30, 30], confidence: 0.9 },
    { bbox: [210, 10, 230, 30], confidence: 0.9 },
  ]);
  const p2 = planDelta(s1, nodes);
  check(p2.report.nodes_changed === 0, 'their hashes are unchanged');
  check(p2.changedMedia.length === 2, `video and canvas are both in changedMedia (got ${p2.changedMedia.length})`);
  check(p2.reusedFaces.length === 0, 'no face of theirs is reused');
}

console.log('\n(K4) a failed detection does not advance state:');
{
  const before = [img('img#one', { attrs: { ...node('x').attrs, src_hash: 'aaaaaaaa' } })];
  const p1 = planDelta(null, before);
  const s1 = advance(null, p1, [{ bbox: [10, 10, 30, 30], confidence: 0.9 }]);
  const after = [img('img#one', { attrs: { ...node('x').attrs, src_hash: 'bbbbbbbb' } })];
  const p2 = planDelta(s1, after);
  check(p2.changedMedia.length === 1, 'the swapped image is changed on step 2');
  const s2 = advance(s1, p2, null);
  check(s2 === s1, 'advance(prev, plan, null) returns prev');
  const p3 = planDelta(s2, after);
  check(p3.changedMedia.length === 1, 'step 3 still re-processes the image that step 2 failed to scan');
  check(advance(null, p1, null) === null, 'a failed first step leaves no state');
}

console.log('\n(K6) dedupe:');
{
  const a = { bbox: [0, 0, 100, 100], confidence: 0.9 };
  const b = { bbox: [1, 1, 100, 100], confidence: 0.8 }; // IoU 0.9801
  const c = { bbox: [0, 0, 100, 50], confidence: 0.8 };  // IoU 0.5
  const kept = dedupeFaces([a, b, c]);
  check(kept.length === 2 && kept[0] === a && kept[1] === c, 'a box with IoU > 0.8 to a kept box is dropped; IoU 0.5 kept');
  const n = img('img#one', { bbox: [0, 0, 200, 200] });
  const s = nextState(new Map(), [n], [a], [b]);
  check(s.facesByPath.get('img#one').length === 1, 'new + reused duplicates are stored once');
}

console.log('\n(K7) padding:');
{
  check(JSON.stringify(padBox([10, 10, 30, 30], 100, 100)) === '[8,8,32,32]', 'padded by 2 px per side');
  check(JSON.stringify(padBox([1, 0, 99, 100], 100, 100)) === '[0,0,100,100]', 'clamped to the viewport');
  // stored boxes stay unpadded, so reuse over many steps does not grow them
  const nodes = [img('img#one')];
  let s = advance(null, planDelta(null, nodes), [{ bbox: [10, 10, 30, 30], confidence: 0.9 }]);
  for (let i = 0; i < 3; i++) { const p = planDelta(s, nodes); s = advance(s, p, []); }
  check(JSON.stringify(s.facesByPath.get('img#one')[0].bbox) === '[10,10,30,30]', 'stored box does not grow across steps');
}

console.log('\nfnv1a:');
check(typeof fnv1a === 'function', 'fnv1a is exported');
check(/^[0-9a-f]{8}$/.test(fnv1a('https://example.com/photo.jpg')), 'fnv1a returns 8 lowercase hex chars');
check(fnv1a('a') !== fnv1a('b'), 'different inputs hash differently');

console.log('\n(F2) a removed node forces every media node to re-process:');
{
  const modal = node('div#modal', { text: 'confirm', bbox: [10, 10, 90, 90] });
  const before = [modal, img('img#one', { bbox: [0, 0, 100, 100] })];
  const p1 = planDelta(null, before);
  const state1 = nextState(p1.hashes, [before[1]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], []);
  const after = [img('img#one', { bbox: [0, 0, 100, 100] })]; // modal removed
  const step2 = planDelta(state1, after);
  check(step2.changedMedia.some((n) => n.path === 'img#one'), 'the image is in changedMedia after an overlapping node disappears');
}

console.log('\n(F2) an unrelated far-away text change leaves the image reused:');
{
  const before = [node('p#far', { text: 'hi', bbox: [500, 500, 520, 520] }), img('img#one', { bbox: [0, 0, 100, 100] })];
  const p1 = planDelta(null, before);
  const state1 = nextState(p1.hashes, [before[1]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], []);
  const after = [node('p#far', { text: 'bye', bbox: [500, 500, 520, 520] }), img('img#one', { bbox: [0, 0, 100, 100] })];
  const step2 = planDelta(state1, after);
  check(step2.changedMedia.length === 0, 'the image is not reprocessed');
  check(step2.reusedFaces.length === 1, "the image's face is reused");
}

console.log('\n(F2) a new node overlapping the image forces it to re-process:');
{
  const before = [img('img#one', { bbox: [0, 0, 100, 100] })];
  const p1 = planDelta(null, before);
  const state1 = nextState(p1.hashes, [before[0]], [{ bbox: [10, 10, 30, 30], confidence: 0.9 }], []);
  const after = [img('img#one', { bbox: [0, 0, 100, 100] }), node('div#overlay', { text: 'new', bbox: [20, 20, 60, 60] })];
  const step2 = planDelta(state1, after);
  check(step2.changedMedia.some((n) => n.path === 'img#one'), 'the image is re-processed when a new node overlaps it');
}

console.log('\n(M2) resolveFaceOutcome — reply/thrown -> outcome:');
{
  const reused = [{ bbox: [1, 1, 2, 2], score: 0.5 }];
  const base = { screenshotDataUrl: 'data:image/png;base64,x', reusedDetections: reused, reusedFacesCount: 1 };

  const notOk = resolveFaceOutcome({ ...base, reply: { ok: false, faces: [], error: 'boom' } });
  check(notOk.screenshotForRequest === null, 'reply.ok false withholds the screenshot');
  check(notOk.note === 'face scan failed — screenshot withheld', 'reply.ok false reports the withheld note');
  check(notOk.failed === true, 'reply.ok false is reported as failed');

  const thrown = resolveFaceOutcome({ ...base, reply: null, thrown: new Error('offscreen crashed') });
  check(thrown.screenshotForRequest === null, 'a thrown error withholds the screenshot');
  check(thrown.note === 'face scan failed — screenshot withheld', 'a thrown error reports the withheld note');
  check(thrown.failed === true, 'a thrown error is reported as failed');

  const ok = resolveFaceOutcome({
    ...base,
    reply: { ok: true, faces: [{ bbox: [5, 5, 6, 6], score: 0.9 }], provider: 'wasm', inference_ms: 12 },
  });
  check(ok.screenshotForRequest === base.screenshotDataUrl, 'a successful reply passes the screenshot through');
  check(ok.failed === false, 'a successful reply is not a failure');
  check(ok.faces.length === 2, 'a successful reply merges new + reused faces');

  const noScreenshot = resolveFaceOutcome({ ...base, screenshotDataUrl: null, reply: null });
  check(noScreenshot.screenshotForRequest === null, 'no screenshot to begin with stays null');
  check(noScreenshot.note === 'no screenshot to scan', 'no screenshot to begin with keeps its own note');
  check(noScreenshot.failed === false, 'no screenshot to begin with is not a failure');
}

console.log('\n(M3) bboxIntersects — touching edges and zero-area boxes:');
{
  check(!bboxIntersects([0, 0, 10, 10], [10, 0, 20, 10]), 'sharing only a vertical edge is not an intersection');
  check(!bboxIntersects([0, 0, 10, 10], [0, 10, 10, 20]), 'sharing only a horizontal edge is not an intersection');
  check(!bboxIntersects([0, 0, 10, 10], [10, 10, 20, 20]), 'sharing only a corner point is not an intersection');
  check(!bboxIntersects([5, 5, 5, 20], [0, 0, 10, 10]), 'a zero-width box never intersects');
  check(!bboxIntersects([5, 5, 20, 5], [0, 0, 10, 10]), 'a zero-height box never intersects');
  check(bboxIntersects([0, 0, 10, 10], [5, 5, 15, 15]), 'overlapping boxes still intersect');
}

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
