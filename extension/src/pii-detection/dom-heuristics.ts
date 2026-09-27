/**
 * Stage 1 of the cascade: DOM and attribute heuristics.
 *
 * Runs first because it is near-free (attribute string tests, no scanning) and
 * the most precise signal available — `type="password"` is not a guess. Anything
 * this stage rules Tier 1 short-circuits the regex stage for that field
 * (CLAUDE.md: don't run expensive detectors on regions cheap ones already
 * decided).
 */
import type { PiiType, RawDomNode } from '../shared/schema';

export interface DomRule {
  type: PiiType;
  detector: string;
  confidence: number;
  test: (node: RawDomNode, context: string) => boolean;
}

/**
 * Everything nameable about a node, lowercased: its label, the dt/th/label text
 * beside it, and its identifying attributes. This is what the context-gated
 * rules match against.
 */
export function contextString(node: RawDomNode): string {
  return [
    node.label,
    node.context_label,
    node.attrs.name,
    node.attrs.id,
    node.attrs.placeholder,
    node.attrs.aria_label,
    node.attrs.autocomplete,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

const ac = (node: RawDomNode): string => (node.attrs.autocomplete ?? '').toLowerCase();

const BARE_NAME_LABELS = new Set([
  'name', 'applicant name', "applicant's name", 'candidate name', 'student name',
  'patient name', 'nominee name', "father's name", "mother's name", 'guardian name',
]);

export const DOM_RULES: DomRule[] = [
  {
    type: 'password',
    detector: 'dom:input-type-password',
    confidence: 0.99,
    test: (n) => n.input_type === 'password' || /(^|\s)(current|new)-password($|\s)/.test(ac(n)),
  },
  {
    type: 'otp',
    detector: 'dom:otp',
    confidence: 0.92,
    test: (n, c) => ac(n) === 'one-time-code' || /\botp\b|one[ -]?time[ -]?(code|password)|verification[ -]?code|2fa/.test(c),
  },
  {
    type: 'card_number',
    detector: 'dom:cc-number',
    confidence: 0.95,
    test: (n, c) => ac(n).includes('cc-number') || /card[ -]?number|cardnum|\bccnum\b|debit[ -]?card|credit[ -]?card/.test(c),
  },
  {
    type: 'cvv',
    detector: 'dom:cc-csc',
    confidence: 0.95,
    // CVV has no recognisable surface form — three digits is three digits — so
    // this rule is the only thing that will ever catch one.
    test: (n, c) => ac(n).includes('cc-csc') || /\bcvv\b|\bcvc\b|\bcsc\b|security[ -]?code/.test(c),
  },
  {
    type: 'card_expiry',
    detector: 'dom:cc-exp',
    confidence: 0.9,
    test: (n, c) => ac(n).includes('cc-exp') || /expir(y|ation)[ -]?(date)?|valid[ -]?thru/.test(c),
  },
  {
    type: 'aadhaar',
    detector: 'dom:aadhaar',
    confidence: 0.92,
    test: (_n, c) => /aadhaar|aadhar|\buidai\b|\buid\b[ -]?number/.test(c),
  },
  {
    type: 'pan',
    detector: 'dom:pan',
    confidence: 0.9,
    // Bare "pan" would hit "panel", "company", "japan" — require it standalone
    // or adjacent to number/card.
    test: (_n, c) => /\bpan\b[ -]?(number|no|card)?\b/.test(c) || /permanent[ -]?account[ -]?number/.test(c),
  },
  {
    type: 'ssn',
    detector: 'dom:ssn',
    confidence: 0.9,
    test: (_n, c) => /\bssn\b|social[ -]?security/.test(c),
  },
  {
    type: 'passport',
    detector: 'dom:passport',
    confidence: 0.9,
    test: (_n, c) => /passport/.test(c),
  },
  {
    type: 'bank_account',
    detector: 'dom:bank-account',
    confidence: 0.88,
    test: (_n, c) => /account[ -]?(number|no)|\bacct\b|\ba\/c\b|beneficiary[ -]?account|\biban\b/.test(c),
  },
  {
    type: 'ifsc',
    detector: 'dom:ifsc',
    confidence: 0.88,
    test: (_n, c) => /\bifsc\b|routing[ -]?number|\bswift\b|\bbic\b/.test(c),
  },
  {
    type: 'email',
    detector: 'dom:email',
    confidence: 0.9,
    test: (n, c) => n.input_type === 'email' || ac(n).includes('email') || /e-?mail/.test(c),
  },
  {
    type: 'phone',
    detector: 'dom:phone',
    confidence: 0.88,
    test: (n, c) => n.input_type === 'tel' || /(^|\s)tel($|\s|-)/.test(ac(n)) || /phone|mobile|contact[ -]?(number|no)/.test(c),
  },
  {
    type: 'address',
    detector: 'dom:address',
    confidence: 0.82,
    test: (n, c) => /street-address|address-line|postal-code/.test(ac(n)) || /address|street|\bpin[ -]?code\b|\bzip\b|postcode/.test(c),
  },
  {
    // A label that is exactly one of BARE_NAME_LABELS ("Name", "Applicant name",
    // "Father's name", ...) also counts. Exact match only, so "File name" and
    // "Bank name" stay Tier 3.
    type: 'person_name',
    detector: 'dom:person-name',
    confidence: 0.82,
    test: (n, c) =>
      /(^|\s)(name|given-name|family-name|additional-name)($|\s)/.test(ac(n)) ||
      /full[ -]?name|first[ -]?name|last[ -]?name|surname|account[ -]?holder|cardholder|your[ -]?name|customer[ -]?name/.test(c) ||
      [n.label, n.context_label].some((l) => l !== null && BARE_NAME_LABELS.has(l.trim().toLowerCase().replace(/[:*\s]+$/, ''))),
  },
  {
    type: 'date_of_birth',
    detector: 'dom:dob',
    confidence: 0.88,
    test: (n, c) => ac(n) === 'bday' || /date[ -]?of[ -]?birth|\bdob\b|birth[ -]?date|birthday/.test(c),
  },
  {
    type: 'account_id',
    detector: 'dom:account-id',
    confidence: 0.85,
    // "account number" also matches here, but bank_account is Tier 1 and
    // `better()` prefers the lower tier, so this only wins where no Tier-1
    // rule fires: customer ids, member numbers, usernames, reference numbers.
    test: (n, c) =>
      /(^|\s)username($|\s)/.test(ac(n)) ||
      /\b(customer|member(ship)?|subscriber|policy|client|user|login|account)[ -_]?(id|number|no|handle)\b|\breference[ -_]?(number|no|id)\b|\bcust(omer)?[ -_]?ref(erence)?\b|\bcrn\b|\buser[ -_]?name\b/.test(c),
  },
];

/**
 * Rules for image regions (img, canvas, svg), which carry no text of their own.
 * A QR code encodes a payee handle or a URL the pixels would hand to anyone who
 * scans the screenshot, so a named QR image is black-boxed and declared as a
 * `frame`, like an iframe.
 */
export const MEDIA_RULES: DomRule[] = [
  {
    type: 'frame',
    detector: 'dom:qr',
    confidence: 0.85,
    test: (n) =>
      [n.attrs.alt, n.attrs.title, n.attrs.id, n.attrs.class, n.attrs.src_file].some(
        // "qr" alone (word-bounded) or "qrcode"/"qr-code"/"qr_code" as a whole
        // token — a qrcode.js canvas commonly uses that as its id/class. Bare
        // "square", "inquiry", "sqrt" must not match either alternative.
        (a) => !!a && /(^|[^a-z])qr([^a-z]|$)|\bqr[-_]?code\b|upi[-_ ]?qr|scan[-_ ]?to[-_ ]?pay/i.test(a),
      ),
  },
  {
    // A canvas can paint arbitrary text or an identifier as pixels, which the
    // DOM walk never sees (audit item D4). Any canvas big enough to hold real
    // content — bigger than a spinner or a sizing hack — is black-boxed and
    // declared like a QR image or an iframe, whatever it was drawn to show.
    type: 'frame',
    detector: 'dom:canvas',
    confidence: 0.85,
    test: (n) => n.tag === 'canvas' && n.bbox[2] - n.bbox[0] > 32 && n.bbox[3] - n.bbox[1] > 32,
  },
];
