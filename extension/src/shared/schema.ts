/**
 * The client↔server contract, plus the local-only types that precede it.
 *
 * THE TRUST BOUNDARY LIVES IN THIS FILE.
 *
 * There are two families of types here and they must never be conflated:
 *
 *   Raw*        — the serialized copy of the page as it actually is. Contains real
 *                 values and real text. LOCAL ONLY. Never serialize one of these
 *                 into a fetch()/WebSocket body.
 *
 *   Sanitized* / AgentRequest
 *               — the §7.1 payload. Every value has been through the redaction
 *                 engine and every removal is described in `redaction_manifest`.
 *                 This is the ONLY shape allowed to cross the network.
 *
 * As of M1 there is no code that constructs an AgentRequest, and the manifest
 * declares no host permissions, so the boundary is enforced by absence. When the
 * redaction engine lands (M2), `redaction/build-request.ts` becomes the single
 * place permitted to produce an AgentRequest — nowhere else.
 */

export const SCHEMA_VERSION = 1;

/** [x1, y1, x2, y2] in viewport CSS pixels, matching PRD §6.2.4. */
export type BBox = [number, number, number, number];

// ---------------------------------------------------------------------------
// PII taxonomy — PRD §4.3. Do not add tiers; add types.
// ---------------------------------------------------------------------------

export type PiiTier = 1 | 2 | 3;

export type PiiType =
  // Tier 1 — hard-block, never leaves the device
  | 'password'
  | 'otp'
  | 'card_number'
  | 'card_expiry'
  | 'cvv'
  | 'aadhaar'
  | 'pan'
  | 'ssn'
  | 'passport'
  | 'bank_account'
  | 'ifsc'
  | 'face'
  /** A region whose contents were never walked — an iframe/embed the DOM walk cannot see into, or a node dropped by the capture budget. Not PII in itself — masked because unscanned pixels are unproven pixels. */
  | 'frame'
  // Tier 2 — mask but preserve shape
  | 'email'
  | 'phone'
  | 'address'
  | 'person_name'
  | 'date_of_birth'
  /** A service-specific identifier: customer/member/policy/reference numbers, usernames. Identifying, not secret. */
  | 'account_id';

export const TIER_BY_TYPE: Record<PiiType, PiiTier> = {
  password: 1,
  otp: 1,
  card_number: 1,
  card_expiry: 1,
  cvv: 1,
  aadhaar: 1,
  pan: 1,
  ssn: 1,
  passport: 1,
  bank_account: 1,
  ifsc: 1,
  face: 1,
  frame: 1,
  email: 2,
  phone: 2,
  address: 2,
  person_name: 2,
  date_of_birth: 2,
  account_id: 2,
};

export type MaskingStrategy = 'blackbox' | 'blur' | 'token' | 'partial';

/** PRD §6.2.4. Describes *what kind* of thing was removed and *where* — never the value. */
export interface RedactionManifestEntry {
  id: string;
  type: PiiType;
  tier: PiiTier;
  bbox: BBox | null;
  dom_path: string | null;
  masking: MaskingStrategy;
  /** Which detector fired; useful for the eval breakdown, harmless to the server. */
  detector: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// LOCAL ONLY — raw capture. Never crosses the network.
// ---------------------------------------------------------------------------

export interface RawDomNode {
  /** Stable-ish CSS selector, unique within the document at capture time. */
  path: string;
  tag: string;
  role: string | null;
  /** Accessible name (simplified accname: aria-labelledby → aria-label → <label> → placeholder → alt/title → own text). */
  label: string | null;
  /** Direct text content of this element only (not descendants), whitespace-collapsed and clipped. */
  text: string | null;
  /**
   * Text of an adjacent labelling element (a preceding <dt>/<th>/<label>/<strong>)
   * for nodes that have no accessible name of their own. Near-zero cost and it
   * turns an anonymous `<dd>50100247716839</dd>` into one the heuristics can
   * classify from its `<dt>Account number</dt>`.
   */
  context_label: string | null;
  /** Raw form value. Deliberately null for password fields — see `value_omitted`. */
  value: string | null;
  /**
   * Set when we chose not to read a value that exists. Password fields are
   * identified with certainty by a DOM heuristic, so copying the secret into the
   * snapshot buys no detection signal and only widens exposure.
   */
  value_omitted: 'password' | null;
  input_type: string | null;
  /** Attributes the M2 heuristic detectors key off. */
  attrs: {
    id: string | null;
    name: string | null;
    autocomplete: string | null;
    placeholder: string | null;
    aria_label: string | null;
    alt: string | null;
    title: string | null;
    inputmode: string | null;
    maxlength: string | null;
  };
  bbox: BBox;
  interactive: boolean;
  /** Non-null for image/video/canvas/svg/picture (regions the face detector scans) and for iframe/frame/object/embed ('iframe' — masked whole, never scanned). */
  media: 'img' | 'video' | 'canvas' | 'svg' | 'picture' | 'iframe' | null;
}

export interface RawSnapshot {
  schema_version: number;
  captured_at: string;
  /** LOCAL ONLY. Query strings routinely carry tokens and identifiers — M2 must redact this before it is ever included in a payload. */
  page_url: string;
  page_title: string;
  viewport: {
    width: number;
    height: number;
    device_pixel_ratio: number;
    scroll_x: number;
    scroll_y: number;
  };
  nodes: RawDomNode[];
  /** True if the node cap was hit and the snapshot is incomplete. */
  truncated: boolean;
  /** Boxes of nodes trimmed by the node budget. Never scanned, so never sent as pixels either — build-request masks and declares them. */
  unscanned: BBox[];
  timings: { dom_walk_ms: number };
}

/** What the service worker hands back to the panel. LOCAL ONLY. */
export interface CaptureResult {
  /** The tab the snapshot was taken from. Execution targets this tab, not "whatever is active now". */
  tab_id: number;
  snapshot: RawSnapshot;
  /** Unredacted PNG data URL. LOCAL ONLY — M3 blurs a canvas copy of this. */
  screenshot_data_url: string | null;
  screenshot_error: string | null;
  timings: {
    dom_walk_ms: number;
    screenshot_ms: number;
    total_ms: number;
  };
}

// ---------------------------------------------------------------------------
// NETWORK — PRD §7. Nothing here may hold a real value.
// ---------------------------------------------------------------------------

export interface SanitizedDomNode {
  path: string;
  role: string | null;
  label: string | null;
  /** null (empty), a Tier-3 pass-through, or a redaction marker such as "[REDACTED:PASSWORD]" / "[EMAIL_1]". */
  value: string | null;
}

/** PRD §7.1. Constructed only by the redaction engine (M2). */
export interface AgentRequest {
  session_id: string;
  task_instruction: string;
  /** Base64 PNG with Tier-1 regions blacked out or blurred. */
  screenshot_redacted: string | null;
  dom_summary: SanitizedDomNode[];
  redaction_manifest: RedactionManifestEntry[];
  prior_actions: PriorAction[];
  /** True when the snapshot hit the node budget: the model sees a partial page. */
  truncated: boolean;
}

/**
 * Action grammar v2 (design spec §Phase 3, owner-confirmed). Nine verbs.
 * `navigate` and `go_back` are tab-level and run in the service worker; the
 * rest run in the content script against the live DOM.
 */
export type ActionVerb = 'click' | 'type' | 'select' | 'key' | 'hover' | 'scroll' | 'go_back' | 'navigate' | 'wait';
export type KeyName = 'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Backspace' | 'Space';
export type ActionRisk = 'routine' | 'sensitive';

export const ACTION_VERBS: ReadonlySet<string> = new Set<ActionVerb>(['click', 'type', 'select', 'key', 'hover', 'scroll', 'go_back', 'navigate', 'wait']);
export const KEY_NAMES: ReadonlySet<string> = new Set<KeyName>(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Space']);
export const TAB_VERBS: ReadonlySet<ActionVerb> = new Set<ActionVerb>(['navigate', 'go_back']);
/** Verbs that must carry a selector. `key` and `scroll` may; the rest must not. */
export const NEEDS_SELECTOR: ReadonlySet<ActionVerb> = new Set<ActionVerb>(['click', 'type', 'select', 'hover']);

export interface AgentAction {
  action: ActionVerb;
  /** click, type, select, hover; optional for key, scroll. Must be a `dom_summary[].path`. */
  selector?: string;
  /** type: non-secret literal. Mutually exclusive with value_ref. */
  value?: string;
  /** type: PRD §7.2 indirection, `user_saved:<slot>`. The provider never sees the secret. */
  value_ref?: string;
  /** select: visible option label (case-insensitive) or option value. */
  option?: string;
  /** key */
  key?: KeyName;
  /** scroll, default down. */
  direction?: 'up' | 'down';
  /** navigate, http(s) only. */
  url?: string;
  /** Anything that submits, pays, sends, deletes, or leaves the site. navigate is always sensitive. */
  risk: ActionRisk;
}

/** History entry: the action as executed plus what happened. `error` is executor text, never a value. */
export interface PriorAction extends AgentAction {
  outcome: 'ok' | 'failed' | 'skipped';
  error?: string;
}

/**
 * PRD §7.2 plus additions. `guardrail_rejections` lists actions the client's
 * planner refused and why. `done`/`result`: the model sets `done: true` when
 * the goal is complete or cannot be advanced and puts the answer or reason in
 * `result`; `result` never speculates about redacted content.
 */
export interface AgentResponse {
  session_id: string;
  reasoning_summary: string;
  actions: AgentAction[];
  requires_client_secret: boolean;
  guardrail_rejections?: string[];
  done: boolean;
  result: string | null;
}
