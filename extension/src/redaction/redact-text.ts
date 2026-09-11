/**
 * Text-level redaction (PRD §6.2.4).
 *
 * Operates on strings taken from the serialized snapshot. Nothing in here can
 * reach the live page — the user's DOM is never touched.
 */
import type { MaskingStrategy, PiiTier, PiiType } from "../shared/schema";

/** Tier 1 is replaced outright; Tier 2 keeps enough shape for the server to reason about the form. */
export function maskingFor(type: PiiType, tier: PiiTier): MaskingStrategy {
  if (tier === 1) return "blackbox";
  // PRD §4.3 offers partial masking or tokenisation for Tier 2. Email keeps a
  // partial because its shape ("this is an address, at some domain") is what
  // makes a login form legible. Phone numbers are tokenised rather than
  // partially masked: trailing digits are the classic "•••• 4242" leak, and the
  // corpus README treats last-four as still sensitive.
  return type === "email" ? "partial" : "token";
}

function partialEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "[EMAIL]";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot === -1 ? "" : domain.slice(dot);
  return `${local[0]}***@***${tld}`;
}

/** The string that replaces a detected item in the outbound payload. */
export function replacementFor(
  type: PiiType,
  tier: PiiTier,
  tokenId: string,
  original: string | null,
): string {
  if (tier === 1) return `[REDACTED:${type.toUpperCase()}]`;
  if (type === "email" && original) return partialEmail(original);
  return `[${tokenId}]`;
}

export interface SpanReplacement {
  span: [number, number];
  replacement: string;
}

/** Applies replacements right-to-left so earlier offsets stay valid. */
export function applySpans(
  content: string,
  replacements: SpanReplacement[],
): string {
  let out = content;
  for (const { span, replacement } of [...replacements].sort(
    (a, b) => b.span[0] - a.span[0],
  )) {
    out = out.slice(0, span[0]) + replacement + out.slice(span[1]);
  }
  return out;
}
