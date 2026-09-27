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
  AgentRequest,
  PriorAction,
  RawDomNode,
  RawSnapshot,
  RedactionManifestEntry,
  SanitizedDomNode,
} from "../shared/schema";
import { TIER_BY_TYPE } from "../shared/schema";
import type { Detection, DetectionField } from "../pii-detection/types";
import { DEFAULT_THRESHOLD, detectPii } from "../pii-detection/detect";
import {
  applySpans,
  maskingFor,
  replacementFor,
  type SpanReplacement,
} from "./redact-text";
import { redactScreenshot, type RedactionRegion } from "./redact-image";
import { scanRequest, type FirewallReport } from "./firewall";
import type { TokenRegistry } from "./tokens";
import type { FaceDetection } from "../perception/face-detect";
import { RawPiiLeakError } from "../shared/errors";

export { RawPiiLeakError };

export interface BuildOptions {
  snapshot: RawSnapshot;
  screenshotDataUrl: string | null;
  taskInstruction: string;
  tokens: TokenRegistry;
  threshold?: number;
  /** Demo-only: names of detectors (DomRule/PatternRule `detector`) to skip, so the firewall's catch is visible. Never affects the firewall itself. */
  disabledDetectors?: Set<string>;
  priorActions?: PriorAction[];
  /**
   * Faces found by the local detector. They arrive separately from the text
   * cascade because they have no DOM representation — a face is pixels in a
   * region, not a value in a node — so they contribute manifest entries and
   * pixel regions but never touch dom_summary.
   */
  faces?: FaceDetection[];
  /**
   * Paths a credential was typed into via value_ref earlier in this run or
   * session. Their live value is the secret itself, so they are declared Tier 1
   * whatever the detectors think of the field.
   */
  forceTier1Paths?: Set<string>;
  /**
   * Values resolved for a credential typed via value_ref earlier in this run or
   * session. A later page can echo one back verbatim — a "Signed in as ..."
   * banner, a receipt line — in a node no detector flags as sensitive. Every
   * dom_summary field and the task instruction is scanned for an exact
   * occurrence and masked before the payload leaves this function.
   */
  typedSecretValues?: Iterable<string>;
  /** 'user_saved:<slot>' names the vault holds — names only, never values. Defaults to []. */
  availableRefs?: string[];
}

/** Matches a value that is *entirely* a redaction marker, not one embedded in other text. */
const WHOLE_FIELD_MARKER = /^\[(?:REDACTED:[^\]]+|[A-Z][A-Z0-9]*_\d+)\]$/;

export interface BuildResult {
  request: AgentRequest;
  detections: Detection[];
  firewall: FirewallReport;
}

/**
 * `value` in the §7.1 shape carries whatever the element says: a form control's
 * value, or a static element's text. The two are told apart by `role`, so the
 * contract stays exactly as documented rather than growing a field.
 */
function contentFieldOf(node: RawDomNode): {
  field: DetectionField;
  content: string | null;
} {
  const isControl =
    node.input_type !== null ||
    node.tag === "textarea" ||
    node.tag === "select";
  return isControl
    ? { field: "value", content: node.value }
    : { field: "text", content: node.text };
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
    // An empty Tier-1 field keeps its manifest entry but sends null: the model
    // can then tell "sensitive and empty" from "sensitive and filled". Capture
    // records an empty value as null; a password it declined to read is not
    // empty (value_omitted) and keeps its marker.
    if (!content && node.value_omitted === null && wholeField.tier === 1) return null;
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

/**
 * Exact-match egress check for credentials this extension typed itself. The
 * screenshot is left out: pixels cannot carry the string, and a short secret
 * would match base64 by chance. Never quotes the value.
 */
export function assertNoTypedSecrets(
  request: AgentRequest,
  values: Iterable<string>,
): void {
  const text = JSON.stringify({ ...request, screenshot_redacted: null });
  for (const value of values) {
    if (value && text.includes(JSON.stringify(value).slice(1, -1)))
      throw new RawPiiLeakError(["a resolved credential appears in the payload"]);
  }
}

export async function buildAgentRequest(
  options: BuildOptions,
): Promise<BuildResult> {
  const { snapshot, screenshotDataUrl, taskInstruction, tokens } = options;
  const detections = detectPii(snapshot, {
    threshold: options.threshold ?? DEFAULT_THRESHOLD,
    disabledDetectors: options.disabledDetectors,
  });

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
    if (node.value_omitted === "password" && !value) {
      const id = tokens.idFor("password", null, node.path);
      manifest.push({
        id,
        type: "password",
        tier: TIER_BY_TYPE.password,
        bbox: node.bbox,
        dom_path: node.path,
        masking: "blackbox",
        detector: "capture:value-omitted",
        confidence: 1,
      });
      value = "[REDACTED:PASSWORD]";
    }

    // Skip only when the field is already wholly a marker (or empty) — a Tier-1
    // entry already existing for this path is not enough to skip on, because a
    // span-based detector can leave a Tier-1 entry behind while raw text
    // (including the typed secret) still sits in the rest of the field.
    const alreadyWholeFieldMasked = value === null || WHOLE_FIELD_MARKER.test(value);
    if (options.forceTier1Paths?.has(node.path) && !alreadyWholeFieldMasked) {
      manifest.push({
        id: tokens.idFor("password", null, node.path),
        type: "password",
        tier: TIER_BY_TYPE.password,
        bbox: node.bbox,
        dom_path: node.path,
        masking: "blackbox",
        detector: "agent:typed-secret",
        confidence: 1,
      });
      value = "[REDACTED:PASSWORD]";
    }

    // A frame's contents were never walked, so nothing about them is proven
    // safe. The frame is declared and its pixels are filled; the node itself
    // stays in dom_summary so the model knows a frame is there.
    if (node.media === "iframe") {
      manifest.push({
        id: tokens.idFor("frame", null, node.path),
        type: "frame",
        tier: TIER_BY_TYPE.frame,
        bbox: node.bbox,
        dom_path: node.path,
        masking: "blackbox",
        detector: "capture:iframe",
        confidence: 1,
      });
    }

    domSummary.push({
      path: node.path,
      role: node.role,
      label: sanitizeField(
        node.label,
        nodeDetections.filter((d) => d.field === "label"),
        node,
        tokens,
        manifest,
      ),
      value,
    });
  }

  // A credential typed via value_ref can be echoed back verbatim later in the
  // same run/session (a confirmation banner, a receipt line) in a node no
  // detector flags. Scan every dom_summary field and the task instruction for
  // the exact typed value and mask it; each affected node gets its own
  // manifest entry so the pixels are blacked out too — redaction is
  // manifest-driven. assertNoTypedSecrets, run by the caller, is the final
  // re-check after this pass, never a substitute for it.
  const typedValues = [...(options.typedSecretValues ?? [])].filter(
    (v): v is string => Boolean(v),
  );
  let maskedTaskInstruction = taskInstruction;
  if (typedValues.length > 0) {
    for (const value of typedValues) {
      maskedTaskInstruction = maskedTaskInstruction
        .split(value)
        .join("[REDACTED:PASSWORD]");
    }
    domSummary.forEach((summaryNode, index) => {
      const rawNode = snapshot.nodes[index]!;
      let affected = false;
      for (const field of ["label", "value"] as const) {
        const original = summaryNode[field];
        if (!original) continue;
        let masked = original;
        for (const value of typedValues) {
          if (masked.includes(value)) {
            masked = masked.split(value).join("[REDACTED:PASSWORD]");
            affected = true;
          }
        }
        summaryNode[field] = masked;
      }
      if (affected) {
        manifest.push({
          id: tokens.idFor("password", null, rawNode.path),
          type: "password",
          tier: TIER_BY_TYPE.password,
          bbox: rawNode.bbox,
          dom_path: rawNode.path,
          masking: "blackbox",
          detector: "agent:typed-secret-echo",
          confidence: 1,
        });
      }
    });
  }

  for (const [index, face] of (options.faces ?? []).entries()) {
    manifest.push({
      id: tokens.idFor("face", null, `face:${index}`),
      type: "face",
      tier: TIER_BY_TYPE.face,
      bbox: face.bbox,
      dom_path: null,
      masking: "blur",
      detector: "onnx:ultraface-rfb320",
      confidence: face.score,
    });
  }

  for (const [index, bbox] of snapshot.unscanned.entries()) {
    manifest.push({
      id: tokens.idFor("frame", null, `unscanned:${index}`),
      type: "frame",
      tier: TIER_BY_TYPE.frame,
      bbox,
      dom_path: null,
      masking: "blackbox",
      detector: "capture:budget",
      confidence: 1,
    });
  }

  const request: AgentRequest = {
    session_id: tokens.session_id,
    task_instruction: maskedTaskInstruction,
    screenshot_redacted: null,
    dom_summary: domSummary,
    redaction_manifest: manifest,
    prior_actions: options.priorActions ?? [],
    truncated: snapshot.truncated,
    available_refs: options.availableRefs ?? [],
  };

  // The firewall is the independent outbound scan that replaces the old
  // context-free assertNoRawPii check (client-side mirror of the server
  // ingress check, PRD §6.2.6) — but it also masks what it finds (Tier 2) and
  // pushes manifest entries for it, rather than merely asserting. It must run
  // before the screenshot is redacted below so a new manifest entry still gets
  // its pixels blacked out.
  const nodesByPath = new Map(snapshot.nodes.map((node) => [node.path, node]));
  const firewall = scanRequest(request, tokens, nodesByPath);

  let screenshotRedacted: string | null = null;
  if (screenshotDataUrl) {
    const regions: RedactionRegion[] = manifest
      .filter((entry) => entry.bbox !== null)
      .map((entry) => ({ bbox: entry.bbox!, masking: entry.masking }));
    screenshotRedacted = await redactScreenshot(
      screenshotDataUrl,
      regions,
      snapshot.viewport.width,
    );
  }
  request.screenshot_redacted = screenshotRedacted;

  // Faces join the returned detections for the viewer's benefit only — they were
  // never part of the node-keyed grouping above.
  const faceDetections: Detection[] = (options.faces ?? []).map(
    (face, index) => ({
      node_path: `(face ${index + 1})`,
      field: "text",
      type: "face",
      tier: TIER_BY_TYPE.face,
      detector: "onnx:ultraface-rfb320",
      confidence: face.score,
      span: null,
      bbox: face.bbox,
    }),
  );

  const frameDetections: Detection[] = snapshot.nodes
    .filter((node) => node.media === "iframe")
    .map((node) => ({
      node_path: node.path,
      field: "text",
      type: "frame",
      tier: TIER_BY_TYPE.frame,
      detector: "capture:iframe",
      confidence: 1,
      span: null,
      bbox: node.bbox,
    }));

  return {
    request,
    detections: [...detections, ...faceDetections, ...frameDetections],
    firewall,
  };
}
