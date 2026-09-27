/**
 * Encrypted local vault (v2) — the client side of the `value_ref` indirection
 * (PRD §7.2) and the home of the provider API key.
 *
 * WORKER-ONLY MODULE. The side panel and the options page never import its
 * functions (a type-only import of VaultStatus is fine); they talk to it through
 * the `athena:vault-*` messages, and values only ever travel panel → worker.
 *
 * The AES-GCM key is derived from the user's passphrase with PBKDF2-SHA256
 * (600k iterations), is non-extractable, and lives only in this worker's memory.
 * storage.local holds ciphertext, salt, iv, the kdf label and `api_key_present`
 * — never the passphrase, the key, a slot value or the API key. A worker restart
 * (MV3 suspends idle workers) or 15 minutes without a resolve or a write locks
 * the vault. This is heuristic protection for a demo, not a password manager:
 * anything that can run code in this worker while it is unlocked can read it.
 */
import { api } from './browser';

const V2_KEY = 'athena:vault:v2';
const V1_KEY = 'athena:vault';
const REF_PREFIX = 'user_saved:';
const PBKDF2_ITERATIONS = 600_000;
export const VAULT_IDLE_MS = 15 * 60 * 1000;

export class VaultLockedError extends Error { constructor() { super('The vault is locked. Unlock it with your passphrase to continue.'); this.name = 'VaultLockedError'; } }
export class UnknownCredentialError extends Error { constructor(readonly ref: string) { super(`No local credential is stored for "${ref}".`); this.name = 'UnknownCredentialError'; } }

export interface VaultData { slots: Record<string, string>; provider_api_key?: string }
export interface VaultStatus { has_vault: boolean; locked: boolean; slots: string[]; api_key_present: boolean; migrated_from_v1: boolean }
interface StoredVault { kdf: 'pbkdf2-sha256-600k'; salt: string; iv: string; ciphertext: string; api_key_present: boolean }

let key: CryptoKey | null = null;
let cache: VaultData | null = null;
let lastUsed = 0;
let migratedFromV1 = false;

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder(); const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function readStored(): Promise<StoredVault | null> {
  return ((await api.storage.local.get(V2_KEY))?.[V2_KEY] as StoredVault | undefined) ?? null;
}

/** Relocks after VAULT_IDLE_MS idle. A status read checks the timer but does not keep the vault alive. */
function touch(refresh = true): void {
  if (key && Date.now() - lastUsed > VAULT_IDLE_MS) lockVault();
  if (refresh) lastUsed = Date.now();
}

function requireUnlocked(): VaultData {
  touch();
  if (!key || !cache) throw new VaultLockedError();
  return cache;
}

async function persist(salt: Uint8Array<ArrayBuffer>): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, enc.encode(JSON.stringify(cache)));
  await api.storage.local.set({ [V2_KEY]: { kdf: 'pbkdf2-sha256-600k', salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), api_key_present: Boolean(cache!.provider_api_key) } satisfies StoredVault });
}
let currentSalt: Uint8Array<ArrayBuffer> | null = null;

export async function vaultStatus(): Promise<VaultStatus> {
  touch(false);
  const stored = await readStored();
  const unlocked = Boolean(key && cache);
  return { has_vault: Boolean(stored), locked: !unlocked, slots: unlocked ? Object.keys(cache!.slots).sort() : [], api_key_present: unlocked ? Boolean(cache!.provider_api_key) : Boolean(stored?.api_key_present), migrated_from_v1: migratedFromV1 };
}

/** Migrates the plaintext v1 vault and the cookie-stored API key, then deletes both. */
async function migrateV1(into: VaultData): Promise<boolean> {
  let migrated = false;
  const v1 = (await api.storage.local.get(V1_KEY))?.[V1_KEY] as Record<string, string> | undefined;
  if (v1 && Object.keys(v1).length) { Object.assign(into.slots, v1); migrated = true; }
  if (v1) await api.storage.local.remove(V1_KEY);
  try {
    const baseUrl = (await api.storage.local.get('athena:provider-base-url'))?.['athena:provider-base-url'] as string | undefined;
    const origin = new URL(baseUrl ?? 'https://openrouter.ai/api/v1').origin;
    const cookie = await api.cookies?.get({ url: `${origin}/__athena_config/`, name: 'athena_api_key' });
    if (cookie?.value) { into.provider_api_key = cookie.value; migrated = true; }
    if (cookie) await api.cookies.remove({ url: `${origin}/__athena_config/`, name: 'athena_api_key' });
  } catch {
    // The `cookies` permission was removed in the release that introduced this
    // vault, so this read only works on profiles where Chrome still has the
    // permission cached; everywhere else the old cookie key is not migrated and
    // the user re-enters it.
  }
  return migrated;
}

export async function unlockVault(passphrase: string): Promise<VaultStatus> {
  const stored = await readStored();
  if (stored) {
    const salt = unb64(stored.salt);
    const candidate = await deriveKey(passphrase, salt);
    let plain: ArrayBuffer;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.iv) }, candidate, unb64(stored.ciphertext)); }
    catch { throw new Error('Wrong passphrase.'); }
    key = candidate; currentSalt = salt; cache = JSON.parse(dec.decode(plain)) as VaultData; lastUsed = Date.now();
    migratedFromV1 = false;
    return vaultStatus();
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  key = await deriveKey(passphrase, salt); currentSalt = salt; cache = { slots: {} }; lastUsed = Date.now();
  migratedFromV1 = await migrateV1(cache);
  await persist(salt);
  return vaultStatus();
}

export function lockVault(): void { key = null; cache = null; currentSalt = null; }

export async function setSlot(slot: string, value: string): Promise<VaultStatus> { const d = requireUnlocked(); d.slots[slot] = value; await persist(currentSalt!); return vaultStatus(); }
export async function deleteSlot(slot: string): Promise<VaultStatus> { const d = requireUnlocked(); delete d.slots[slot]; await persist(currentSalt!); return vaultStatus(); }
export async function setProviderApiKey(value: string | null): Promise<VaultStatus> { const d = requireUnlocked(); if (value) d.provider_api_key = value; else delete d.provider_api_key; await persist(currentSalt!); return vaultStatus(); }
export async function getProviderApiKey(): Promise<string | null> { return requireUnlocked().provider_api_key ?? null; }
export async function vaultSlotRefs(): Promise<string[]> { touch(false); if (!key || !cache) return []; return Object.keys(cache.slots).sort().map((s) => REF_PREFIX + s); }

export async function resolveValueRef(ref: string): Promise<string> {
  if (!ref.startsWith(REF_PREFIX)) throw new UnknownCredentialError(ref);
  const value = requireUnlocked().slots[ref.slice(REF_PREFIX.length)];
  if (value === undefined) throw new UnknownCredentialError(ref);
  return value;
}
