/**
 * Encrypted local vault (v2) — the client side of the `value_ref` indirection
 * (PRD §7.2) and the home of the provider API key.
 *
 * WORKER-ONLY MODULE. The side panel and the options page never import its
 * functions (a type-only import of VaultStatus is fine); they talk to it through
 * the `athena:vault-*` messages, and values only ever travel panel → worker.
 *
 * The AES-GCM key is derived from the user's passphrase with PBKDF2-SHA256
 * (600k iterations). storage.local holds ciphertext, salt, iv, the kdf label and
 * `api_key_present` — never the passphrase, the key, a slot value or the API key.
 * The CryptoKey used for encryption is non-extractable.
 *
 * Unlock survives MV3 worker suspension (this supersedes the earlier "key in
 * worker memory only" design): right after PBKDF2 the raw key bytes are exported
 * once and kept in chrome.storage.session under 'athena:vault-key' with a
 * last-used time; a restarted worker re-imports them as a non-extractable key.
 * 15 minutes without a resolve, an API-key read or a write locks the vault; a
 * status read does not count as activity.
 *
 * RESIDUAL RISK: while the vault is unlocked, the raw key is readable by
 * extension pages (not content scripts — the session store keeps its default
 * trusted-contexts access level; nothing here changes it). It lives in
 * Chrome's memory-backed session store and is cleared on browser exit,
 * extension reload or Lock. Anything that can run code in the worker or an
 * extension page while unlocked can read the vault. This is heuristic
 * protection for a demo, not a password manager.
 */
import { api } from './browser';

const V2_KEY = 'athena:vault:v2';
const V1_KEY = 'athena:vault';
const SESSION_KEY = 'athena:vault-key';
const REF_PREFIX = 'user_saved:';
const PBKDF2_ITERATIONS = 600_000;
const SESSION_WRITE_DEBOUNCE_MS = 30_000;
export const VAULT_IDLE_MS = 15 * 60 * 1000;

export class VaultLockedError extends Error { constructor(message = 'The vault is locked. Unlock it with your passphrase to continue.') { super(message); this.name = 'VaultLockedError'; } }
export class UnknownCredentialError extends Error { constructor(readonly ref: string) { super(`No local credential is stored for "${ref}".`); this.name = 'UnknownCredentialError'; } }
/** A user-facing refusal (wrong passphrase, mismatch, no vault): safe to show as-is. */
export class VaultError extends Error { constructor(message: string) { super(message); this.name = 'VaultError'; } }

export interface VaultData { slots: Record<string, string>; provider_api_key?: string }
export interface VaultStatus { has_vault: boolean; locked: boolean; slots: string[]; api_key_present: boolean; migrated_from_v1: boolean }
interface StoredVault { kdf: 'pbkdf2-sha256-600k'; salt: string; iv: string; ciphertext: string; api_key_present: boolean }
interface SessionKey { raw: string; last_used: number }

let key: CryptoKey | null = null;
let cache: VaultData | null = null;
let currentSalt: Uint8Array<ArrayBuffer> | null = null;
let lastUsed = 0;
let sessionLastUsed = 0;
let migratedFromV1 = false;

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder(); const dec = new TextDecoder();
const importAes = (raw: BufferSource) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** PBKDF2 → raw bytes (exported once from an extractable derivation) + the non-extractable key used from then on. */
async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<{ raw: ArrayBuffer; key: CryptoKey }> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const exportable = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', exportable);
  return { raw, key: await importAes(raw) };
}

async function readStored(): Promise<StoredVault | null> {
  return ((await api.storage.local.get(V2_KEY))?.[V2_KEY] as StoredVault | undefined) ?? null;
}
async function readSession(): Promise<SessionKey | null> {
  return ((await api.storage.session.get(SESSION_KEY))?.[SESSION_KEY] as SessionKey | undefined) ?? null;
}

/** Restores the key from the session store after a worker restart; enforces the idle timeout. */
async function load(): Promise<void> {
  if (key && Date.now() - lastUsed > VAULT_IDLE_MS) await lockVault();
  if (key) return;
  const session = await readSession();
  if (!session) return;
  if (Date.now() - session.last_used > VAULT_IDLE_MS) { await lockVault(); return; }
  const stored = await readStored();
  if (!stored) { await lockVault(); return; }
  try {
    const restored = await importAes(unb64(session.raw));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.iv) }, restored, unb64(stored.ciphertext));
    key = restored; cache = JSON.parse(dec.decode(plain)) as VaultData; currentSalt = unb64(stored.salt);
    lastUsed = sessionLastUsed = session.last_used;
  } catch { await lockVault(); }
}

/** Counts as activity: refreshes last-used in memory, and in the session store at most every 30 s. */
async function touch(): Promise<void> {
  lastUsed = Date.now();
  if (lastUsed - sessionLastUsed <= SESSION_WRITE_DEBOUNCE_MS) return;
  const session = await readSession();
  if (!session) return;
  sessionLastUsed = lastUsed;
  await api.storage.session.set({ [SESSION_KEY]: { raw: session.raw, last_used: lastUsed } satisfies SessionKey });
}

async function requireUnlocked(): Promise<VaultData> {
  await load();
  if (!key || !cache) throw new VaultLockedError();
  await touch();
  return cache;
}

async function persist(salt: Uint8Array<ArrayBuffer>): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, enc.encode(JSON.stringify(cache)));
  await api.storage.local.set({ [V2_KEY]: { kdf: 'pbkdf2-sha256-600k', salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), api_key_present: Boolean(cache!.provider_api_key) } satisfies StoredVault });
}

async function adopt(derived: { raw: ArrayBuffer; key: CryptoKey }, salt: Uint8Array<ArrayBuffer>, data: VaultData): Promise<void> {
  key = derived.key; currentSalt = salt; cache = data; lastUsed = sessionLastUsed = Date.now();
  await api.storage.session.set({ [SESSION_KEY]: { raw: b64(derived.raw), last_used: lastUsed } satisfies SessionKey });
}

export async function vaultStatus(): Promise<VaultStatus> {
  await load(); // not activity: a status read never keeps the vault alive
  const stored = await readStored();
  const unlocked = Boolean(key && cache);
  return { has_vault: Boolean(stored), locked: !unlocked, slots: unlocked ? Object.keys(cache!.slots).sort() : [], api_key_present: unlocked ? Boolean(cache!.provider_api_key) : Boolean(stored?.api_key_present), migrated_from_v1: migratedFromV1 };
}

const COOKIE_NAME = 'athena_api_key';
/** Reads (never deletes) the plaintext v1 vault and the cookie-stored API key. */
async function readV1(): Promise<{ slots: Record<string, string>; apiKey: string | null; hadV1: boolean; cookieUrl: string | null }> {
  const v1 = (await api.storage.local.get(V1_KEY))?.[V1_KEY] as Record<string, string> | undefined;
  let apiKey: string | null = null; let cookieUrl: string | null = null;
  try {
    const baseUrl = (await api.storage.local.get('athena:provider-base-url'))?.['athena:provider-base-url'] as string | undefined;
    const url = `${new URL(baseUrl ?? 'https://openrouter.ai/api/v1').origin}/__athena_config/`;
    const cookie = await api.cookies?.get({ url, name: COOKIE_NAME });
    if (cookie) { cookieUrl = url; apiKey = cookie.value || null; }
  } catch {
    // The `cookies` permission was removed in the release that introduced this
    // vault, so this read only works on profiles where Chrome still has the
    // permission cached; everywhere else the old cookie key is not migrated and
    // the user re-enters it.
  }
  return { slots: v1 ?? {}, apiKey, hadV1: v1 !== undefined, cookieUrl };
}

/** Creates the vault (none may exist yet), importing the v1 vault and cookie key; the old copies are removed only after the new vault is persisted. */
export async function createVault(passphrase: string, confirm: string): Promise<VaultStatus> {
  if (passphrase !== confirm) throw new VaultError('The passphrases do not match.');
  if (passphrase.length < 8) throw new VaultError('Use a passphrase of at least 8 characters.');
  if (await readStored()) throw new VaultError('A vault already exists. Unlock it instead.');
  const old = await readV1();
  const data: VaultData = { slots: { ...old.slots } };
  if (old.apiKey) data.provider_api_key = old.apiKey;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveKey(passphrase, salt);
  key = derived.key; cache = data; currentSalt = salt;
  try { await persist(salt); } catch (err) { key = null; cache = null; currentSalt = null; throw err; }
  await adopt(derived, salt, data);
  if (old.hadV1) await api.storage.local.remove(V1_KEY);
  if (old.cookieUrl) { try { await api.cookies.remove({ url: old.cookieUrl, name: COOKIE_NAME }); } catch { /* see readV1 */ } }
  migratedFromV1 = Object.keys(old.slots).length > 0 || Boolean(old.apiKey);
  return vaultStatus();
}

export async function unlockVault(passphrase: string): Promise<VaultStatus> {
  const stored = await readStored();
  if (!stored) throw new VaultError('No vault yet. Create one in Settings.');
  const salt = unb64(stored.salt);
  const derived = await deriveKey(passphrase, salt);
  let plain: ArrayBuffer;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.iv) }, derived.key, unb64(stored.ciphertext)); }
  catch { throw new VaultError('Wrong passphrase.'); }
  await adopt(derived, salt, JSON.parse(dec.decode(plain)) as VaultData);
  migratedFromV1 = false;
  return vaultStatus();
}

export async function lockVault(): Promise<void> {
  key = null; cache = null; currentSalt = null; migratedFromV1 = false;
  await api.storage.session.remove(SESSION_KEY);
}

/** Test hook: forget the in-memory key as a worker restart would. */
export function __resetMemoryForTests(): void { key = null; cache = null; currentSalt = null; }

export async function setSlot(slot: string, value: string): Promise<VaultStatus> { const d = await requireUnlocked(); d.slots[slot] = value; await persist(currentSalt!); return vaultStatus(); }
export async function deleteSlot(slot: string): Promise<VaultStatus> { const d = await requireUnlocked(); delete d.slots[slot]; await persist(currentSalt!); return vaultStatus(); }
export async function setProviderApiKey(value: string | null): Promise<VaultStatus> { const d = await requireUnlocked(); if (value) d.provider_api_key = value; else delete d.provider_api_key; await persist(currentSalt!); return vaultStatus(); }
export async function getProviderApiKey(): Promise<string | null> {
  await load();
  if (!key && !(await readStored())) throw new VaultLockedError('No vault yet. Create one in Settings to store your API key.');
  return (await requireUnlocked()).provider_api_key ?? null;
}
export async function vaultSlotRefs(): Promise<string[]> { await load(); if (!key || !cache) return []; return Object.keys(cache.slots).sort().map((s) => REF_PREFIX + s); }

export async function resolveValueRef(ref: string): Promise<string> {
  if (!ref.startsWith(REF_PREFIX)) throw new UnknownCredentialError(ref);
  const value = (await requireUnlocked()).slots[ref.slice(REF_PREFIX.length)];
  if (value === undefined) throw new UnknownCredentialError(ref);
  return value;
}
