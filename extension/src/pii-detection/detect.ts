/**
 * The detector cascade (PRD §6.2.3), ordered cheapest-and-most-precise first.
 *
 *   1. DOM/attribute heuristics — attribute string tests, no scanning
 *   2. Regex/pattern matchers   — only on fields stage 1 did not already cover
 *   3. local NER                — cut from this build
 *   4. face detection           — M3, operates on image regions not text
 *
 * A field claimed whole by stage 1 is not re-scanned by stage 2: the answer
 * cannot improve and the work is not free (CLAUDE.md).
 *
 * These are pure functions over a serialized RawSnapshot with no DOM access, so
 * `eval/run_eval.py` can replay the exact production cascade over corpus
 * snapshots in Node without driving a browser.
 *
 * KNOWN LIMITATION — pixel geometry is node-granular. A detection spanning part
 * of a text node gets that node's bbox, because sub-element rectangles need
 * Range geometry that only exists in the content script. The effect is
 * over-redaction of pixels around inline matches, never under-redaction, which
 * is the direction PRD §9 commits to. Text redaction is exact either way.
 */
import type { RawDomNode, RawSnapshot } from '../shared/schema';
import { TIER_BY_TYPE } from '../shared/schema';
import type { Detection, DetectionField } from './types';
import { DOM_RULES, contextString } from './dom-heuristics';
import { PATTERNS } from './patterns';

/**
 * Conservative by default: bias toward over-redaction (PRD §9, §13 Q3). Lower
 * means more is redacted. Exposed as a slider so the trade-off is visible rather
 * than buried in a constant.
 */
export const DEFAULT_THRESHOLD = 0.5;

export interface DetectOptions {
  threshold?: number;
}

/**
 * Elements whose text names a value rather than being one: <dt>Account number</dt>,
 * <label>NetBanking password</label>.
 *
 * These are Tier 3 by definition (PRD §4.3 — "field names/types" are structural)
 * and the server needs them to understand the form at all. Stage 1 must not
 * touch their text: a rule keyed on the word "password" would otherwise redact
 * the very label that told it what the field was. Stage 2 still scans them,
 * since a label can literally contain an address ("Email us at x@y.com").
 */
const STRUCTURAL_TAGS = new Set(['label', 'dt', 'th', 'legend', 'caption']);

/** Form controls carry their sensitive content in `value`; everything else in `text`. */
function dataFieldOf(node: RawDomNode): DetectionField {
  return node.input_type !== null || node.tag === 'textarea' || node.tag === 'select' ? 'value' : 'text';
}

/** More severe wins: lower tier first, then higher confidence, then longer span. */
function better(a: Detection, b: Detection): Detection {
  if (a.tier !== b.tier) return a.tier < b.tier ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  const lenA = a.span ? a.span[1] - a.span[0] : Infinity;
  const lenB = b.span ? b.span[1] - b.span[0] : Infinity;
  return lenA >= lenB ? a : b;
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** Collapses overlapping matches within one field so a value is masked once. */
function resolveOverlaps(detections: Detection[]): Detection[] {
  const kept: Detection[] = [];
  for (const candidate of detections.sort((x, y) => (x.span?.[0] ?? 0) - (y.span?.[0] ?? 0))) {
    const clashIndex = kept.findIndex(
      (k) => k.span && candidate.span && overlaps(k.span, candidate.span),
    );
    if (clashIndex === -1) kept.push(candidate);
    else kept[clashIndex] = better(kept[clashIndex]!, candidate);
  }
  return kept;
}

export function detectPii(snapshot: RawSnapshot, options: DetectOptions = {}): Detection[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const out: Detection[] = [];

  for (const node of snapshot.nodes) {
    const context = contextString(node);
    const dataField = dataFieldOf(node);
    /** Fields stage 1 claimed in their entirety — stage 2 skips these. */
    const claimed = new Set<DetectionField>();

    // ---- stage 1: DOM/attribute heuristics -------------------------------
    let best: Detection | null = null;
    const structural = dataField === 'text' && STRUCTURAL_TAGS.has(node.tag);
    for (const rule of structural ? [] : DOM_RULES) {
      if (rule.confidence < threshold) continue;
      if (!rule.test(node, context)) continue;
      const hit: Detection = {
        node_path: node.path,
        field: dataField,
        type: rule.type,
        tier: TIER_BY_TYPE[rule.type],
        detector: rule.detector,
        confidence: rule.confidence,
        span: null,
        bbox: node.bbox,
      };
      best = best ? better(best, hit) : hit;
    }
    if (best) {
      out.push(best);
      claimed.add(dataField);
    }

    // ---- stage 2: regex over whatever is left ----------------------------
    const scannable: Array<[DetectionField, string | null]> = [
      ['value', node.value],
      ['text', node.text],
      ['label', node.label],
    ];

    for (const [field, content] of scannable) {
      if (!content || claimed.has(field)) continue;
      const found: Detection[] = [];

      for (const pattern of PATTERNS) {
        if (pattern.confidence < threshold) continue;
        if (pattern.requires_context && !pattern.requires_context.test(context)) continue;

        for (const match of content.matchAll(pattern.regex)) {
          const text = match[0];
          const start = match.index ?? 0;
          if (!text.trim()) continue;
          if (pattern.validate && !pattern.validate(text)) continue;
          found.push({
            node_path: node.path,
            field,
            type: pattern.type,
            tier: TIER_BY_TYPE[pattern.type],
            detector: pattern.detector,
            confidence: pattern.confidence,
            span: [start, start + text.length],
            bbox: node.bbox,
          });
        }
      }
      out.push(...resolveOverlaps(found));
    }
  }

  return out;
}
