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
 * Consequently this registry lives in service-worker memory and is NEVER
 * written to chrome.storage, IndexedDB, or anywhere else. Do not add persistence.
 */
import type { PiiType } from "../shared/schema";

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@.]/g, "");
}

export class TokenRegistry {
  readonly session_id: string;
  private counters = new Map<PiiType, number>();
  private assigned = new Map<string, string>();

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
    if (existing) return existing;

    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    const id = `${type.toUpperCase()}_${next}`;
    this.assigned.set(key, id);
    return id;
  }

  get size(): number {
    return this.assigned.size;
  }
}

export function newSessionId(): string {
  return crypto.randomUUID();
}
