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
import { DOM_RULES, MEDIA_RULES, contextString } from './dom-heuristics';
import { PATTERNS, foldDigits } from './patterns';
import { isAadhaar, isPaymentCard } from './validators';

/**
 * Conservative by default: bias toward over-redaction (PRD §9, §13 Q3). Lower
 * means more is redacted. Exposed as a slider so the trade-off is visible rather
 * than buried in a constant.
 */
export const DEFAULT_THRESHOLD = 0.5;

export interface DetectOptions {
  threshold?: number;
  /**
   * Detector names (the `detector` field of a `DomRule`/`PatternRule`) to skip
   * this pass — a demo-only switch (`athena:debug-disabled-detectors`) that
   * proves the firewall (`redaction/firewall.ts`) catches what the cascade
   * misses. The firewall has no equivalent switch: this option affects
   * `detectPii` alone.
   */
  disabledDetectors?: Set<string>;
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
const STRUCTURAL_TAGS = new Set(['label', 'dt', 'th', 'legend', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function isControl(node: RawDomNode): boolean {
  return node.input_type !== null || node.tag === 'textarea' || node.tag === 'select';
}

/** Form controls carry their sensitive content in `value`; everything else in `text`. */
function dataFieldOf(node: RawDomNode): DetectionField {
  return isControl(node) ? 'value' : 'text';
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

const OTP_RULE = DOM_RULES.find((r) => r.detector === 'dom:otp')!;
const GROUP_CONFIDENCE = 0.9;

/**
 * A card or OTP split across sibling boxes (capture's `group_id`): no single
 * box holds a checkable number, so the members' contents are joined in
 * document order and validated as one. A hit marks every member whole-field.
 */
function groupHits(snapshot: RawSnapshot, threshold: number, disabled?: Set<string>): Map<string, Detection> {
  const hits = new Map<string, Detection>();
  if (GROUP_CONFIDENCE < threshold) return hits;
  const groups = new Map<string, RawDomNode[]>();
  for (const node of snapshot.nodes) {
    if (!node.group_id) continue;
    const members = groups.get(node.group_id) ?? [];
    members.push(node);
    groups.set(node.group_id, members);
  }
  for (const members of groups.values()) {
    const joined = foldDigits(members.map((m) => (m.value ?? m.text ?? '').trim()).join(''));
    let found: [Detection['type'], string] | null = null;
    if (isPaymentCard(joined)) found = ['card_number', 'group:card'];
    else if (isAadhaar(joined)) found = ['aadhaar', 'group:aadhaar'];
    else if (
      members.length >= 4 && members.length <= 8 &&
      members.every((m) => m.attrs.maxlength === '1' && OTP_RULE.test(m, contextString(m)))
    ) found = ['otp', 'group:otp'];
    if (!found || disabled?.has(found[1])) continue;
    for (const m of members) {
      hits.set(m.path, {
        node_path: m.path,
        field: dataFieldOf(m),
        type: found[0],
        tier: TIER_BY_TYPE[found[0]],
        detector: found[1],
        confidence: GROUP_CONFIDENCE,
        span: null,
        bbox: m.bbox,
      });
    }
  }
  return hits;
}

export function detectPii(snapshot: RawSnapshot, options: DetectOptions = {}): Detection[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const disabled = options.disabledDetectors;
  const out: Detection[] = [];
  const grouped = groupHits(snapshot, threshold, disabled);

  for (const node of snapshot.nodes) {
    const context = contextString(node);
    const dataField = dataFieldOf(node);
    /** Fields stage 1 claimed in their entirety — stage 2 skips these. */
    const claimed = new Set<DetectionField>();

    // ---- stage 1: DOM/attribute heuristics -------------------------------
    let best: Detection | null = null;
    // A control is always eligible: an empty password or OTP field is still Tier 1
    // (corpus rule). Anything else only carries a value in its text, so a button
    // or link — whose text is never captured — has nothing a rule could redact,
    // and flagging it paints a black box over "Resend OTP".
    const structural = dataField === 'text' && (STRUCTURAL_TAGS.has(node.tag) || !node.text);
    // Image regions have no text; only the media rules (QR) apply to them.
    const rules = node.media && node.media !== 'iframe' ? MEDIA_RULES : structural ? [] : DOM_RULES;
    for (const rule of rules) {
      if (disabled?.has(rule.detector)) continue;
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
    // A split-box group is judged as a whole; only a stricter tier overrides it.
    const group = grouped.get(node.path);
    if (group && (!best || group.tier <= best.tier)) best = group;
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
      // Native-script digits folded to ASCII, length-preserving: spans index `content`.
      const folded = foldDigits(content);

      for (const pattern of PATTERNS) {
        if (disabled?.has(pattern.detector)) continue;
        if (pattern.confidence < threshold) continue;
        if (pattern.requires_context && !pattern.requires_context.test(context)) continue;

        for (const match of folded.matchAll(pattern.regex)) {
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
