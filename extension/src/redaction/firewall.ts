/**
 * Independent outbound scanner (design spec §C). Deliberately does NOT import
 * pii-detection/*: a bug shared with the detectors would be a bug in both
 * layers. Rules are self-validating where a checksum exists. A Tier-1 hit means
 * the request is not sent; a Tier-2 hit is masked in place with a registry
 * token and declared in the manifest.
 *
 * This runs on the fully-assembled request, after the detector cascade and
 * before the screenshot is redacted — so a hit here still gets its pixels
 * blacked out, and a demo can disable a named detector (`detect.ts`'s
 * `disabledDetectors`) to show the firewall catching what the cascade missed.
 * The firewall itself has no such switch.
 */
import type { AgentRequest, PiiType, RawDomNode, RedactionManifestEntry } from '../shared/schema';
import { TIER_BY_TYPE } from '../shared/schema';
import type { TokenRegistry } from './tokens';
import { RawPiiLeakError } from '../shared/errors';

export interface FirewallRule { name: string; type: PiiType; regex: RegExp; validate?: (m: string) => boolean }

const digitsOf = (s: string) => s.replace(/\D/g, '');
const luhn = (s: string) => { const d = digitsOf(s); let sum = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]!; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return d.length >= 12 && sum % 10 === 0; };
const VERHOEFF_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VERHOEFF_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const verhoeff = (s: string) => { const d = digitsOf(s); if (d.length !== 12) return false; let c = 0; const rev = [...d].reverse(); for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![+rev[i]!]!]!; return c === 0; };
const mod97 = (s: string) => { const iban = s.replace(/\s+/g, '').toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false; const r = iban.slice(4) + iban.slice(0, 4); let rem = 0; for (const ch of r) { const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const c of v) rem = (rem * 10 + +c) % 97; } return rem === 1; };

export const FIREWALL_RULES: FirewallRule[] = [
  { name: 'email', type: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'upi', type: 'account_id', regex: /\b[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}\b(?![.\w])/g },
  { name: 'card', type: 'card_number', regex: /\b(?:\d[ -]?){12,19}\b/g, validate: luhn },
  { name: 'aadhaar', type: 'aadhaar', regex: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, validate: verhoeff },
  { name: 'pan', type: 'pan', regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { name: 'ifsc', type: 'ifsc', regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { name: 'iban', type: 'bank_account', regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, validate: mod97 },
  { name: 'ssn', type: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'phone-in', type: 'phone', regex: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
];

const TOKEN_OR_MARKER = /\[(?:REDACTED:[A-Z_]+|[A-Z][A-Z0-9_]*_\d+)\]/g;

/** Folds full-width and other compatibility digits (and other scripts' decimal digits) to ASCII before matching. */
const DIGIT_ZEROS = [0x0030, 0x0660, 0x06F0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0xFF10];
const foldDigits = (s: string) => s.normalize('NFKC').replace(/\p{Nd}/gu, (d) => { const cp = d.codePointAt(0)!; for (const zero of DIGIT_ZEROS) if (cp >= zero && cp <= zero + 9) return String(cp - zero); return d; });

export interface FirewallHit { type: PiiType; rule: string; field: string; action: 'masked' | 'blocked' }
export interface FirewallReport { fields_scanned: number; masked: number; blocked: number; hits: FirewallHit[] }

function scanText(text: string): { rule: FirewallRule; match: string; index: number }[] {
  const folded = foldDigits(text);
  const out: { rule: FirewallRule; match: string; index: number }[] = [];
  const shielded = folded.replace(TOKEN_OR_MARKER, (m) => ' '.repeat(m.length)); // existing tokens never re-fire
  for (const rule of FIREWALL_RULES) for (const m of shielded.matchAll(rule.regex)) {
    if (rule.validate && !rule.validate(m[0])) continue;
    out.push({ rule, match: folded.slice(m.index!, m.index! + m[0].length), index: m.index! });
  }
  return out;
}

export function scanRequest(request: AgentRequest, registry: TokenRegistry, nodesByPath: Map<string, Pick<RawDomNode, 'path' | 'bbox'>>): FirewallReport {
  const report: FirewallReport = { fields_scanned: 0, masked: 0, blocked: 0, hits: [] };
  const maskField = (text: string, field: string, path: string | null): string => {
    report.fields_scanned++;
    let out = foldDigits(text);
    const hits = scanText(text).sort((a, b) => b.index - a.index);
    for (const { rule, match } of hits) {
      const tier = TIER_BY_TYPE[rule.type];
      if (tier === 1) { report.blocked++; report.hits.push({ type: rule.type, rule: rule.name, field, action: 'blocked' }); continue; }
      const id = registry.idFor(rule.type, match, path ?? field);
      out = out.split(match).join(`[${id}]`);
      report.masked++; report.hits.push({ type: rule.type, rule: rule.name, field, action: 'masked' });
      if (path) request.redaction_manifest.push({ id, type: rule.type, tier, bbox: nodesByPath.get(path)?.bbox ?? null, dom_path: path, masking: 'token', detector: `firewall:${rule.name}`, confidence: 1 } as RedactionManifestEntry);
    }
    return out;
  };
  request.task_instruction = maskField(request.task_instruction, 'task_instruction', null);
  for (const node of request.dom_summary) {
    if (node.label) node.label = maskField(node.label, `${node.path}.label`, node.path);
    if (node.value) node.value = maskField(node.value, `${node.path}.value`, node.path);
  }
  for (const [i, a] of request.prior_actions.entries()) if (a.value) a.value = maskField(a.value, `prior_actions[${i}].value`, null);
  if (report.blocked > 0) {
    const err = new RawPiiLeakError(report.hits.filter((h) => h.action === 'blocked').map((h) => `${h.field} matches firewall:${h.rule}`)) as RawPiiLeakError & { report?: FirewallReport };
    err.report = report;
    throw err;
  }
  return report;
}
