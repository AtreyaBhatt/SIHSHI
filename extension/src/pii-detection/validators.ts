/**
 * Checksum validators. These are the difference between flagging every long
 * digit run and flagging actual sensitive numbers — i.e. between ~0.3 and ~0.95
 * precision on the numeric types (PRD §8 targets ≥0.80 overall).
 */

/** Mod-10. Used for payment cards. */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Verhoeff (dihedral group D5) — the checksum UIDAI uses for Aadhaar.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D[c]![P[i % 8]![d]!]!;
  }
  return c === 0;
}

/** Aadhaar: 12 digits, never starts 0 or 1, Verhoeff-checked. */
export function isAadhaar(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  return d.length === 12 && /^[2-9]/.test(d) && verhoeff(d);
}

/**
 * Payment card: Luhn plus an issuer-identifier sanity check. Luhn alone passes
 * ~10% of random digit strings, which is enough to flag account numbers and
 * order ids as cards.
 */
export function isPaymentCard(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (![13, 14, 15, 16, 19].includes(d.length)) return false;
  if (!/^[3-6]/.test(d)) return false;
  return luhn(d);
}
