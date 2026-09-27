/** Encrypted vault round trips in Node with WebCrypto and a fake chrome.storage. Usage: npm run test:vault */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-vault-'));
const local = {}; const cookies = new Map();
globalThis.chrome = {
  storage: { local: { get: async (k) => { const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => x in local).map((x) => [x, local[x]])); }, set: async (v) => Object.assign(local, v), remove: async (k) => { for (const x of [].concat(k)) delete local[x]; } } },
  cookies: { get: async ({ url, name }) => cookies.get(`${new URL(url).origin}:${name}`) ?? null, remove: async ({ url, name }) => { cookies.delete(`${new URL(url).origin}:${name}`); } },
  permissions: { contains: async () => true },
};
await build({ entryPoints: ['src/shared/vault.ts'], outfile: join(temp, 'vault.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
const v = await import(`file://${join(temp, 'vault.mjs')}`);
let failures = 0; const check = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failures++; console.error(`  FAIL ${m}`); } };

let s = await v.vaultStatus();
check(!s.has_vault && s.locked && s.slots.length === 0, 'fresh install: no vault, locked');
await v.unlockVault('correct horse');
s = await v.setSlot('aadhaar', '2345 6789 0124');
check(s.has_vault && !s.locked && s.slots.includes('aadhaar'), 'unlock creates the vault and stores a slot');
check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'resolves a slot');
check(JSON.stringify(local).includes('2345 6789 0124') === false, 'storage.local never contains the plaintext');
check(JSON.stringify(local).includes('correct horse') === false, 'storage.local never contains the passphrase');
s = await v.setProviderApiKey('sk-test-123');
check(s.api_key_present && (await v.getProviderApiKey()) === 'sk-test-123', 'API key stored and readable while unlocked');
v.lockVault();
s = await v.vaultStatus();
check(s.locked && s.slots.length === 0 && s.api_key_present === true, 'locked: slot names hidden, key presence still known');
let threw = false; try { await v.resolveValueRef('user_saved:aadhaar'); } catch (e) { threw = e.name === 'VaultLockedError'; }
check(threw, 'resolving while locked throws VaultLockedError');
threw = false; try { await v.unlockVault('wrong'); } catch (e) { threw = /Wrong passphrase/.test(e.message); }
check(threw && (await v.vaultStatus()).has_vault, 'wrong passphrase is refused and the vault is intact');
await v.unlockVault('correct horse');
check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'correct passphrase restores access');
check((await v.vaultSlotRefs()).includes('user_saved:aadhaar'), 'slot refs are listed');

console.log('migration');
{
  for (const k of Object.keys(local)) delete local[k];
  v.lockVault();
  local['athena:vault'] = { username: 'demo-user-42' };
  local['athena:provider-base-url'] = 'https://openrouter.ai/api/v1';
  cookies.set('https://openrouter.ai:athena_api_key', { value: 'sk-old' });
  const m = await v.unlockVault('new pass');
  check(m.migrated_from_v1 && m.slots.includes('username') && m.api_key_present, 'v1 slots and the cookie key are imported');
  check(local['athena:vault'] === undefined && !cookies.has('https://openrouter.ai:athena_api_key'), 'plaintext vault and cookie removed');
  check((await v.getProviderApiKey()) === 'sk-old', 'imported key readable');
}

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
