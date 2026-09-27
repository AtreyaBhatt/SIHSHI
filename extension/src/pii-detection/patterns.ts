/**
 * Stage 2 of the cascade: regex matchers over extracted text.
 *
 * Only structured, checksummable formats are matched context-free. Types whose
 * surface form is ambiguous — a bare 6-digit OTP, a bank account number, a
 * person's name — are gated on `requires_context`, because matching them
 * everywhere would flag order ids, prices and prose, and precision is scored
 * (PRD §8) just as heavily as recall.
 *
 * What this stage deliberately CANNOT catch: names and addresses in free prose.
 * That needs the local NER model (PRD §6.2.3 step 3), cut from this build. The
 * DOM heuristics catch them when they sit in a labelled field; loose in a
 * paragraph they are missed, and the eval will show that as a recall gap rather
 * than hide it.
 */
import type { PiiType } from '../shared/schema';
import { isAadhaar, isPaymentCard } from './validators';

export interface PatternRule {
  type: PiiType;
  detector: string;
  /** Must be sticky-free and global; matched with matchAll. */
  regex: RegExp;
  confidence: number;
  /** Rejects a syntactic match that fails a checksum or range test. */
  validate?: (match: string) => boolean;
  /** When set, the match only counts if the node's context string matches too. */
  requires_context?: RegExp;
}

/** ISO 13616 mod-97 check. */
export function isIban(raw: string): boolean {
  const s = raw.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = parseInt(ch, 36);
    rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97;
  }
  return rem === 1;
}

/** Zero code points of the BMP decimal-digit blocks (Arabic-Indic through fullwidth). */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0xff10];

/**
 * Maps non-ASCII decimal digits (Devanagari, Bengali, Tamil, fullwidth, ...) to
 * ASCII one code unit for one, so a span found in the folded string indexes
 * the original unchanged.
 */
export function foldDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\u09e6-\u09ef\u0a66-\u0a6f\u0ae6-\u0aef\u0b66-\u0b6f\u0be6-\u0bef\u0c66-\u0c6f\u0ce6-\u0cef\u0d66-\u0d6f\u0e50-\u0e59\uff10-\uff19]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9)!;
    return String(code - zero);
  });
}

export const PATTERNS: PatternRule[] = [
  {
    type: 'email',
    detector: 'regex:email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.95,
  },
  {
    // UPI handle (name@bank). After email and at lower confidence, so an email
    // address overlapping it wins in resolveOverlaps.
    type: 'account_id',
    detector: 'regex:upi',
    regex: /\b[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}\b(?!\.?\w)/g,
    confidence: 0.85,
  },
  {
    type: 'bank_account',
    detector: 'regex:iban+mod97',
    // Case-insensitive: an IBAN typed or rendered in lowercase is still an
    // IBAN. The match is uppercased before the mod-97 check below.
    regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi,
    confidence: 0.9,
    validate: (m) => isIban(m.toUpperCase()),
  },
  {
    type: 'card_number',
    detector: 'regex:card_number+luhn',
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 0.95,
    validate: isPaymentCard,
  },
  {
    type: 'aadhaar',
    detector: 'regex:aadhaar+verhoeff',
    regex: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    confidence: 0.95,
    validate: isAadhaar,
  },
  {
    type: 'pan',
    detector: 'regex:pan',
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    confidence: 0.9,
  },
  {
    type: 'ifsc',
    detector: 'regex:ifsc',
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    confidence: 0.9,
  },
  {
    type: 'ssn',
    detector: 'regex:ssn',
    regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    confidence: 0.9,
  },
  {
    type: 'phone',
    detector: 'regex:phone-intl',
    regex: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,5}[ -]?\d{3,5}(?:[ -]?\d{2,4})?/g,
    confidence: 0.75,
    // Requires a + prefix or exactly 10 national digits; anything else is a
    // number, not a phone number.
    validate: (m) => {
      const digits = m.replace(/\D/g, '');
      if (m.trim().startsWith('+')) return digits.length >= 8 && digits.length <= 15;
      return digits.length === 10 && /^[6-9]/.test(digits);
    },
  },
  {
    type: 'bank_account',
    detector: 'regex:bank_account(context)',
    regex: /\b\d{9,18}\b/g,
    confidence: 0.8,
    requires_context: /account|a\/c|\bacct\b|beneficiary|iban/i,
  },
  {
    type: 'passport',
    detector: 'regex:passport(context)',
    regex: /\b[A-PR-WY][0-9]{7}\b/g,
    confidence: 0.8,
    requires_context: /passport/i,
  },
  {
    type: 'otp',
    detector: 'regex:otp(context)',
    regex: /\b\d{4,8}\b/g,
    confidence: 0.8,
    requires_context: /\botp\b|one[ -]?time|verification code|auth(entication)? code|2fa/i,
  },
  {
    type: 'date_of_birth',
    detector: 'regex:dob(context)',
    regex: /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g,
    confidence: 0.8,
    requires_context: /birth|\bdob\b|born/i,
  },
];
