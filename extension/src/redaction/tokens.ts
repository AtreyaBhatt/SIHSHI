/**
 * Session-scoped placeholder tokens.
 *
 * The same value seen twice in one session gets the same token, so the server
 * can say "the email field you showed me earlier" across turns without ever
 * learning the value. Across sessions the mapping is regenerated, which is the
 * whole point of PRD §9.4 — a token that outlived its session would become a
 * stable pseudonymous identifier, exactly the re-identification handle the
 * design is meant to deny.
 *
 * The registry may be mirrored to chrome.storage.session (browser-session
 * scoped, memory-backed — it never touches disk and is cleared when the
 * browser session ends) so a service-worker restart mid-run does not restart
 * token numbering or lose the id→value map a typed token needs to resolve.
 * It must NEVER be written to chrome.storage.local, IndexedDB, or anywhere
 * else that survives a browser session — PRD §9.4 still holds because the
 * mirror dies with the browser session, not with this object.
 */
import type { PiiType } from "../shared/schema";

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@.]/g, "");
}

export interface RegistryJSON {
  session_id: string;
  counters: [string, number][];
  assigned: [string, string][];
  values: [string, string][];
}

export class TokenRegistry {
  readonly session_id: string;
  private counters = new Map<PiiType, number>();
  private assigned = new Map<string, string>();
  /** id → original value, for local resolution of a typed token. Memory + storage.session only. */
  private values = new Map<string, string>();

  constructor(sessionId: string) {
    this.session_id = sessionId;
  }

  /**
   * `value` is null for a sensitive field we never read (a password) or one that
   * is empty. Those key off the node path instead, so two empty password fields
   * on the same form stay distinguishable.
   */
  idFor(type: PiiType, value: string | null, nodePath: string): string {
    const key = value ? `${type}:${normalize(value)}` : `${type}@${nodePath}`;
    const existing = this.assigned.get(key);
    if (existing) {
      if (value && !this.values.has(existing)) this.values.set(existing, value);
      return existing;
    }

    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    const id = `${type.toUpperCase()}_${next}`;
    this.assigned.set(key, id);
    if (value) this.values.set(id, value);
    return id;
  }

  /** Resolves a token id (no brackets, e.g. 'AADHAAR_1') to the value it stands for, if any was recorded. */
  valueOf(id: string): string | undefined {
    return this.values.get(id);
  }

  get size(): number {
    return this.assigned.size;
  }

  toJSON(): RegistryJSON {
    return {
      session_id: this.session_id,
      counters: [...this.counters],
      assigned: [...this.assigned],
      values: [...this.values],
    };
  }

  static from(json: RegistryJSON): TokenRegistry {
    const r = new TokenRegistry(json.session_id);
    r.counters = new Map(json.counters as [PiiType, number][]);
    r.assigned = new Map(json.assigned);
    r.values = new Map(json.values);
    return r;
  }
}

export function newSessionId(): string {
  return crypto.randomUUID();
}
