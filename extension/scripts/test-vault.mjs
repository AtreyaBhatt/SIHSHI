/** Encrypted vault round trips in Node with WebCrypto and a fake chrome.storage. Usage: npm run test:vault */
import { build } from 'esbuild';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-vault-'));
const local = {}; const session = {}; const cookies = new Map();
const area = (store) => ({ get: async (k) => { const keys = Array.isArray(k) ? k : [k]; return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]])); }, set: async (v) => Object.assign(store, v), remove: async (k) => { for (const x of [].concat(k)) delete store[x]; } });
let setAccessLevelCalls = 0; let failNextLocalSet = false; let failNextSessionSet = false;
const localArea = area(local); const realLocalSet = localArea.set;
localArea.set = async (v) => { if (failNextLocalSet) { failNextLocalSet = false; throw new Error('quota'); } return realLocalSet(v); };
const sessionArea = area(session); const realSessionSet = sessionArea.set;
sessionArea.set = async (v) => { if (failNextSessionSet) { failNextSessionSet = false; throw new Error('session quota'); } return realSessionSet(v); };
globalThis.chrome = {
  storage: { local: localArea, session: { ...sessionArea, setAccessLevel: async () => { setAccessLevelCalls++; } } },
  cookies: { get: async ({ url, name }) => cookies.get(`${new URL(url).origin}:${name}`) ?? null, remove: async ({ url, name }) => { cookies.delete(`${new URL(url).origin}:${name}`); } },
  permissions: { contains: async () => true },
};
await build({ entryPoints: ['src/shared/vault.ts'], outfile: join(temp, 'vault.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
const v = await import(`file://${join(temp, 'vault.mjs')}`);
let failures = 0; const check = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failures++; console.error(`  FAIL ${m}`); } };

let s = await v.vaultStatus();
check(!s.has_vault && s.locked && s.slots.length === 0, 'fresh install: no vault, locked');
let err = null; try { await v.getProviderApiKey(); } catch (e) { err = e; }
check(err?.name === 'VaultLockedError' && /No vault yet/.test(err.message), 'fresh install: API key read says to create a vault (VaultLockedError)');
err = null; try { await v.unlockVault('correct horse'); } catch (e) { err = e; }
check(/No vault yet/.test(err?.message ?? '') && !(await v.vaultStatus()).has_vault, 'unlock with no vault fails and creates nothing');
err = null; try { await v.createVault('correct horse', 'correct horsE'); } catch (e) { err = e; }
check(/do not match/.test(err?.message ?? ''), 'create refuses mismatched confirmation');
err = null; try { await v.createVault('short', 'short'); } catch (e) { err = e; }
check(/at least 8/.test(err?.message ?? ''), 'create refuses a passphrase under 8 characters');
await v.createVault('correct horse', 'correct horse');
err = null; try { await v.createVault('correct horse', 'correct horse'); } catch (e) { err = e; }
check(/already exists/.test(err?.message ?? ''), 'create twice fails');
s = await v.setSlot('aadhaar', '2345 6789 0124');
check(s.has_vault && !s.locked && s.slots.includes('aadhaar'), 'create unlocks the vault and stores a slot');
check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'resolves a slot');
check(JSON.stringify(local).includes('2345 6789 0124') === false, 'storage.local never contains the plaintext');
check(JSON.stringify(local).includes('correct horse') === false, 'storage.local never contains the passphrase');
s = await v.setProviderApiKey('sk-test-123');
check(s.api_key_present && (await v.getProviderApiKey()) === 'sk-test-123', 'API key stored and readable while unlocked');
check(JSON.stringify(local).includes('sk-test-123') === false, 'storage.local never contains the API key');
check(typeof session['athena:vault-key']?.raw === 'string' && typeof session['athena:vault-key']?.last_used === 'number', 'unlock stores the raw key and last_used in storage.session');
await v.lockVault();
check(session['athena:vault-key'] === undefined, 'lock removes the session key');
s = await v.vaultStatus();
check(s.locked && s.slots.length === 0 && s.api_key_present === true, 'locked: slot names hidden, key presence still known');
let threw = false; try { await v.resolveValueRef('user_saved:aadhaar'); } catch (e) { threw = e.name === 'VaultLockedError'; }
check(threw, 'resolving while locked throws VaultLockedError');
threw = false; try { await v.unlockVault('wrong'); } catch (e) { threw = /Wrong passphrase/.test(e.message); }
check(threw && (await v.vaultStatus()).has_vault, 'wrong passphrase is refused and the vault is intact');
await v.unlockVault('correct horse');
check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'correct passphrase restores access');
check((await v.vaultSlotRefs()).includes('user_saved:aadhaar'), 'slot refs are listed');

console.log('session restore and idle');
{
  v.__resetMemoryForTests();
  check((await v.resolveValueRef('user_saved:aadhaar')) === '2345 6789 0124', 'after a worker restart the next resolve works from the session entry');
  const fiveMin = Date.now() - 5 * 60 * 1000;
  session['athena:vault-key'].last_used = fiveMin;
  v.__resetMemoryForTests();
  const st = await v.vaultStatus();
  check(!st.locked && session['athena:vault-key'].last_used === fiveMin, 'vaultStatus restores but does not refresh last_used');
  await v.vaultSlotRefs();
  check(session['athena:vault-key'].last_used === fiveMin, 'vaultSlotRefs does not refresh last_used');
  await v.resolveValueRef('user_saved:aadhaar');
  check(Date.now() - session['athena:vault-key'].last_used < 5000, 'resolveValueRef refreshes last_used in the session store');
  session['athena:vault-key'].last_used = Date.now() - 16 * 60 * 1000;
  v.__resetMemoryForTests();
  const idle = await v.vaultStatus();
  check(idle.locked && session['athena:vault-key'] === undefined, 'idle 16 min: relocked on load and the session key removed');
  threw = false; try { await v.resolveValueRef('user_saved:aadhaar'); } catch (e) { threw = e.name === 'VaultLockedError'; }
  check(threw, 'resolve after idle relock throws VaultLockedError');
  const sources = (await readdir('src', { recursive: true })).filter((f) => f.endsWith('.ts'));
  const callers = []; for (const f of sources) if ((await readFile(join('src', f), 'utf8')).includes('setAccessLevel')) callers.push(f);
  check(setAccessLevelCalls === 0 && callers.length === 0, `nothing calls storage.session.setAccessLevel (${callers.join(', ') || 'no source mentions it'})`);
}

console.log('migration');
{
  for (const k of Object.keys(local)) delete local[k];
  await v.lockVault();
  local['athena:vault'] = { username: 'demo-user-42' };
  local['athena:provider-base-url'] = 'https://openrouter.ai/api/v1';
  cookies.set('https://openrouter.ai:athena_api_key', { value: 'sk-old' });
  failNextLocalSet = true;
  err = null; try { await v.createVault('new passphrase', 'new passphrase'); } catch (e) { err = e; }
  check(err && local['athena:vault']?.username === 'demo-user-42' && cookies.has('https://openrouter.ai:athena_api_key') && !local['athena:vault:v2'] && (await v.vaultStatus()).locked, 'persist failure during migration leaves the v1 vault and cookie intact');
  const m = await v.createVault('new passphrase', 'new passphrase');
  check(m.migrated_from_v1 && m.slots.includes('username') && m.api_key_present, 'v1 slots and the cookie key are imported');
  check(local['athena:vault'] === undefined && !cookies.has('https://openrouter.ai:athena_api_key'), 'plaintext vault and cookie removed');
  check((await v.getProviderApiKey()) === 'sk-old', 'imported key readable');
  await v.lockVault();
  check(!(await v.vaultStatus()).migrated_from_v1, 'lock resets migrated_from_v1');
  for (const k of Object.keys(local)) delete local[k];
  local['athena:vault'] = {};
  const e = await v.createVault('another pass', 'another pass');
  check(local['athena:vault'] === undefined && !e.migrated_from_v1, 'an empty v1 object is deleted (nothing to report as migrated)');
}

console.log('R1: lock wins over an in-flight touch');
{
  // The vault is unlocked (from the migration block above) with passphrase 'another pass'.
  await v.setSlot('race', 'value');
  // Make the in-memory session bookkeeping look stale so the next touch() clears the 30 s
  // debounce and actually reaches its own storage.session.get call (same trick as the idle
  // tests above), then drop the in-memory key so resolveValueRef must go through load() first.
  session['athena:vault-key'].last_used = Date.now() - 60_000;
  v.__resetMemoryForTests();
  let release; const parked = new Promise((res) => { release = res; });
  let calls = 0;
  const originalGet = chrome.storage.session.get;
  chrome.storage.session.get = async (k) => { calls++; if (calls === 2) await parked; return originalGet(k); };
  const resolving = v.resolveValueRef('user_saved:race');
  await new Promise((r) => setTimeout(r, 20)); // let load() finish and touch() park on its own get
  await v.lockVault();
  release();
  let raceErr = null; try { await resolving; } catch (e) { raceErr = e; }
  chrome.storage.session.get = originalGet;
  check(calls >= 2, 'the parked touch() actually reached its own storage.session.get call');
  const status = await v.vaultStatus();
  check(status.locked && session['athena:vault-key'] === undefined, 'lock wins: vaultStatus is locked and the session entry is absent after a parked touch');
  check(raceErr?.name === 'VaultLockedError', 'lock wins: the parked resolve throws VaultLockedError instead of returning stale data');
}

console.log('R2: v1 cleanup does not depend on the session write succeeding');
{
  await v.lockVault();
  for (const k of Object.keys(local)) delete local[k];
  local['athena:vault'] = { legacy: 'yes' };
  local['athena:provider-base-url'] = 'https://openrouter.ai/api/v1';
  cookies.set('https://openrouter.ai:athena_api_key', { value: 'sk-r2' });
  failNextSessionSet = true;
  err = null; try { await v.createVault('r2 passphrase', 'r2 passphrase'); } catch (e) { err = e; }
  check(Boolean(err) && local['athena:vault:v2'] !== undefined, 'the vault still persists even though the session write failed');
  check(local['athena:vault'] === undefined && !cookies.has('https://openrouter.ai:athena_api_key'), 'v1 vault and cookie are removed even though adopt() failed');
}

console.log('R5: concurrent creates are serialized');
{
  await v.lockVault();
  for (const k of Object.keys(local)) delete local[k];
  const p1 = v.createVault('concurrent pass', 'concurrent pass');
  let err2 = null; try { await v.createVault('other pass', 'other pass'); } catch (e) { err2 = e; }
  check(/already being created/.test(err2?.message ?? ''), 'a second create while one is in flight is refused');
  const s1 = await p1;
  check(s1.has_vault && !s1.locked, 'the first create still completes normally');
}

await rm(temp, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
