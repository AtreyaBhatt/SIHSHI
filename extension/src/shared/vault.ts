/**
 * Local credential vault — the client side of the `value_ref` indirection (PRD §7.2).
 *
 * The server never sends a secret and never receives one. It names a slot
 * ("user_saved:password") and this resolves that name to a value that has never
 * left the machine.
 *
 * PRD §13 Q2 asked whether to integrate the browser's native password manager.
 * The answer is forced: Chrome exposes no extension API for reading stored
 * credentials, so a user-populated local vault is the only option. That makes
 * this a DEMO vault — chrome.storage.local is not encrypted at rest, and any
 * other extension with storage permission on this profile can read it. It is not
 * a password manager and the options page says so to the user's face. Do not
 * describe it as secure in demo copy.
 */
import { api } from './browser';

const VAULT_KEY = 'ppva:vault';
const REF_PREFIX = 'user_saved:';

export type Vault = Record<string, string>;

export async function readVault(): Promise<Vault> {
  const stored = await api.storage.local.get(VAULT_KEY);
  return (stored?.[VAULT_KEY] as Vault | undefined) ?? {};
}

export async function writeVault(vault: Vault): Promise<void> {
  await api.storage.local.set({ [VAULT_KEY]: vault });
}

/** Slot names only — used to show the user what is stored without showing values. */
export async function vaultSlots(): Promise<string[]> {
  return Object.keys(await readVault()).sort();
}

export class UnknownCredentialError extends Error {
  constructor(readonly ref: string) {
    super(`No local credential is stored for "${ref}".`);
    this.name = 'UnknownCredentialError';
  }
}

/**
 * Resolves "user_saved:<slot>" to its value.
 *
 * Throws rather than returning empty for an unknown slot: silently typing "" into
 * a password field looks like a working agent right up until the user wonders why
 * the login failed.
 */
export async function resolveValueRef(ref: string): Promise<string> {
  if (!ref.startsWith(REF_PREFIX)) throw new UnknownCredentialError(ref);
  const slot = ref.slice(REF_PREFIX.length);
  const value = (await readVault())[slot];
  if (value === undefined) throw new UnknownCredentialError(ref);
  return value;
}
