/**
 * Errors shared across the redaction layer.
 *
 * Lives here (not in build-request.ts or firewall.ts) so neither of those two
 * modules has to import the other: build-request re-exports this for existing
 * callers, and firewall.ts imports it directly.
 */
export class RawPiiLeakError extends Error {
  constructor(readonly offenders: string[]) {
    super(
      `Refusing to build a payload: ${offenders.length} raw PII pattern(s) survived redaction — ${offenders.join("; ")}`,
    );
    this.name = "RawPiiLeakError";
  }
}
