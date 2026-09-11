/**
 * THE ONLY PLACE PERMITTED TO CONSTRUCT AN AgentRequest.
 *
 * Everything upstream of this file deals in Raw* types holding real values.
 * Everything downstream deals in the §7.1 payload. If you find yourself
 * assembling a request object anywhere else, that is the bug CLAUDE.md warns
 * about, not a shortcut.
 *
 * The function fails closed: after building the payload it re-runs the
 * context-free pattern matchers over every string in it, and throws rather than
 * return a payload that still matches one. That mirrors the server's ingress
 * check (PRD §6.2.6) on the client side, so a detector regression surfaces as a
 * refusal to build rather than as a leak.
 */
import type {
  AgentAction,
  AgentRequest,
  RawDomNode,
  RawSnapshot,
  RedactionManifestEntry,
  SanitizedDomNode,
} from '../shared/schema';
import { TIER_BY_TYPE } from '../shared/schema';
import type { Detection, DetectionField } from '../pii-detection/types';
import { DEFAULT_THRESHOLD, detectPii } from '../pii-detection/detect';
import { PATTERNS } from '../pii-detection/patterns';
import { applySpans, maskingFor, replacementFor, type SpanReplacement } from './redact-text';
import { redactScreenshot, type RedactionRegion } from './redact-image';
import type { TokenRegistry } from './tokens';
import type { FaceDetection } from '../perception/face-detect';

export interface BuildOptions {
  snapshot: RawSnapshot;
  screenshotDataUrl: string | null;
  taskInstruction: string;
  tokens: TokenRegistry;
  threshold?: number;
  priorActions?: AgentAction[];
  /**
   * Faces found by the local detector. They arrive separately from the text
   * cascade because they have no DOM representation — a face is pixels in a
   * region, not a value in a node — so they contribute manifest entries and
   * pixel regions but never touch dom_summary.
   */
  faces?: FaceDetection[];
}

export interface BuildResult {
  request: AgentRequest;
  detections: Detection[];
}

export class RawPiiLeakError extends Error {
  constructor(readonly offenders: string[]) {
    super(`Refusing to build a payload: ${offenders.length} raw PII pattern(s) survived redaction — ${offenders.join('; ')}`);
    this.name = 'RawPiiLeakError';
  }
}

/**
 * `value` in the §7.1 shape carries whatever the element says: a form control's
 * value, or a static element's text. The two are told apart by `role`, so the
 * contract stays exactly as documented rather than growing a field.
 */
function contentFieldOf(node: RawDomNode): { field: DetectionField; content: string | null } {
  const isControl = node.input_type !== null || node.tag === 'textarea' || node.tag === 'select';
  return isControl ? { field: 'value', content: node.value } : { field: 'text', content: node.text };
}

function sanitizeField(
  content: string | null,
  detections: Detection[],
  node: RawDomNode,
  tokens: TokenRegistry,
  manifest: RedactionManifestEntry[],
): string | null {
  if (detections.length === 0) return content;

  const wholeField = detections.find((d) => d.span === null);
  if (wholeField) {
    const id = tokens.idFor(wholeField.type, content, node.path);
    manifest.push({
      id,
      type: wholeField.type,
      tier: wholeField.tier,
      bbox: wholeField.bbox,
      dom_path: node.path,
      masking: maskingFor(wholeField.type, wholeField.tier),
      detector: wholeField.detector,
      confidence: wholeField.confidence,
    });
    return replacementFor(wholeField.type, wholeField.tier, id, content);
  }

  if (!content) return content;

  const replacements: SpanReplacement[] = [];
  for (const detection of detections) {
    if (!detection.span) continue;
    const original = content.slice(detection.span[0], detection.span[1]);
    const id = tokens.idFor(detection.type, original, node.path);
    manifest.push({
      id,
      type: detection.type,
      tier: detection.tier,
      bbox: detection.bbox,
      dom_path: node.path,
      masking: maskingFor(detection.type, detection.tier),
      detector: detection.detector,
      confidence: detection.confidence,
    });
    replacements.push({
      span: detection.span,
      replacement: replacementFor(detection.type, detection.tier, id, original),
    });
  }
  return applySpans(content, replacements);
}

/** Client-side mirror of the server ingress check (PRD §6.2.6). */
function assertNoRawPii(request: AgentRequest): void {
  const offenders: string[] = [];
  const fields: Array<[string, string | null | undefined]> = [['task_instruction', request.task_instruction]];
  for (const node of request.dom_summary) fields.push([`${node.path}.label`, node.label], [`${node.path}.value`, node.value]);
  for (const [i, action] of request.prior_actions.entries()) fields.push([`prior_actions[${i}].value`, action.value]);

  for (const [where, text] of fields) {
    if (!text) continue;
    for (const pattern of PATTERNS) {
      // Context-gated patterns are ambiguous by construction (a bare digit run
      // is only an account number given a label), so they would fire on benign
      // text here. Only the self-validating formats are assertable.
      if (pattern.requires_context) continue;
      for (const match of text.matchAll(pattern.regex)) {
        if (pattern.validate && !pattern.validate(match[0])) continue;
        offenders.push(`${where} matches ${pattern.detector}`);
      }
    }
  }
  if (offenders.length > 0) throw new RawPiiLeakError(offenders);
}

export async function buildAgentRequest(options: BuildOptions): Promise<BuildResult> {
  const { snapshot, screenshotDataUrl, taskInstruction, tokens } = options;
  const detections = detectPii(snapshot, { threshold: options.threshold ?? DEFAULT_THRESHOLD });

  const byNode = new Map<string, Detection[]>();
  for (const detection of detections) {
    const list = byNode.get(detection.node_path);
    if (list) list.push(detection);
    else byNode.set(detection.node_path, [detection]);
  }

  const manifest: RedactionManifestEntry[] = [];
  const domSummary: SanitizedDomNode[] = [];

  for (const node of snapshot.nodes) {
    const nodeDetections = byNode.get(node.path) ?? [];
    const { field, content } = contentFieldOf(node);

    let value = sanitizeField(
      content,
      nodeDetections.filter((d) => d.field === field),
      node,
      tokens,
      manifest,
    );

    // Belt and braces: a password value we declined to read at capture time must
    // still be declared, even if every detector somehow missed the field.
    if (node.value_omitted === 'password' && !value) {
      const id = tokens.idFor('password', null, node.path);
      manifest.push({
        id,
        type: 'password',
        tier: TIER_BY_TYPE.password,
        bbox: node.bbox,
        dom_path: node.path,
        masking: 'blackbox',
        detector: 'capture:value-omitted',
        confidence: 1,
      });
      value = '[REDACTED:PASSWORD]';
    }

    // A frame's contents were never walked, so nothing about them is proven
    // safe. The frame is declared and its pixels are filled; the node itself
    // stays in dom_summary so the model knows a frame is there.
    if (node.media === 'iframe') {
      manifest.push({
        id: tokens.idFor('frame', null, node.path),
        type: 'frame',
        tier: TIER_BY_TYPE.frame,
        bbox: node.bbox,
        dom_path: node.path,
        masking: 'blackbox',
        detector: 'capture:iframe',
        confidence: 1,
      });
    }

    domSummary.push({
      path: node.path,
      role: node.role,
      label: sanitizeField(
        node.label,
        nodeDetections.filter((d) => d.field === 'label'),
        node,
        tokens,
        manifest,
      ),
      value,
    });
  }

  for (const [index, face] of (options.faces ?? []).entries()) {
    manifest.push({
      id: tokens.idFor('face', null, `face:${index}`),
      type: 'face',
      tier: TIER_BY_TYPE.face,
      bbox: face.bbox,
      dom_path: null,
      masking: 'blur',
      detector: 'onnx:ultraface-rfb320',
      confidence: face.score,
    });
  }

  let screenshotRedacted: string | null = null;
  if (screenshotDataUrl) {
    const regions: RedactionRegion[] = manifest
      .filter((entry) => entry.bbox !== null)
      .map((entry) => ({ bbox: entry.bbox!, masking: entry.masking }));
    screenshotRedacted = await redactScreenshot(screenshotDataUrl, regions, snapshot.viewport.width);
  }

  const request: AgentRequest = {
    session_id: tokens.session_id,
    task_instruction: taskInstruction,
    screenshot_redacted: screenshotRedacted,
    dom_summary: domSummary,
    redaction_manifest: manifest,
    prior_actions: options.priorActions ?? [],
    truncated: snapshot.truncated,
  };

  assertNoRawPii(request);

  // Faces join the returned detections for the viewer's benefit only — they were
  // never part of the node-keyed grouping above.
  const faceDetections: Detection[] = (options.faces ?? []).map((face, index) => ({
    node_path: `(face ${index + 1})`,
    field: 'text',
    type: 'face',
    tier: TIER_BY_TYPE.face,
    detector: 'onnx:ultraface-rfb320',
    confidence: face.score,
    span: null,
    bbox: face.bbox,
  }));

  const frameDetections: Detection[] = snapshot.nodes
    .filter((node) => node.media === 'iframe')
    .map((node) => ({
      node_path: node.path,
      field: 'text',
      type: 'frame',
      tier: TIER_BY_TYPE.frame,
      detector: 'capture:iframe',
      confidence: 1,
      span: null,
      bbox: node.bbox,
    }));

  return { request, detections: [...detections, ...faceDetections, ...frameDetections] };
}
