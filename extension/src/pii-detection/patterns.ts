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

export const PATTERNS: PatternRule[] = [
  {
    type: 'email',
    detector: 'regex:email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.95,
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
