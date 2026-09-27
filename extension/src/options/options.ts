import { api } from '../shared/browser';
import { ensureProviderOriginPermission, readProviderSettings, saveProviderSettings, type ProviderSettings } from '../shared/provider-settings';
import type { PanelToWorker, ResponseFor, WorkerReply } from '../shared/messages';
import type { VaultStatus } from '../shared/vault'; // type only: the vault itself lives in the worker

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const format = $<HTMLInputElement>('anthropic-format');
const baseUrl = $<HTMLInputElement>('provider-base-url');
const model = $<HTMLInputElement>('provider-model');
const key = $<HTMLInputElement>('provider-api-key');
const del = $<HTMLButtonElement>('delete-api-key');
const health = $('provider-health');
const slots = $('slots');
const vaultStatus = $('vault-status');
const lockState = $('vault-lock-state');
let current: ProviderSettings | null = null;
let vault: VaultStatus | null = null;

async function send<M extends PanelToWorker>(message: M): Promise<ResponseFor<M>> {
  const reply = (await api.runtime.sendMessage(message)) as WorkerReply<ResponseFor<M>> | undefined;
  if (!reply) throw new Error('The extension worker did not respond — try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
const say = (el: HTMLElement) => (err: unknown) => { el.textContent = err instanceof Error ? err.message : String(err); };
function esc(value: string): string { return value.replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!); }
function renderProvider(settings: ProviderSettings): void {
  current = settings; const present = Boolean(vault?.api_key_present);
  format.checked = settings.anthropic_format; baseUrl.value = settings.base_url; model.value = settings.model; key.value = '';
  key.placeholder = present ? 'API key stored — leave blank to keep it' : 'Enter provider API key'; del.hidden = !present;
  health.textContent = present ? `Configured · ${settings.anthropic_format ? 'anthropic' : 'openai'} · ${settings.base_url}${vault?.locked ? ' · vault locked' : ''}` : 'Not configured · unlock the vault and add an API key to enable planning.';
}
function renderVault(status: VaultStatus): void {
  vault = status;
  lockState.textContent = !status.has_vault ? 'No vault yet. Choose a passphrase and press Unlock to create one.'
    : status.locked ? 'Vault locked — unlock to view slot names or plan.' : `Unlocked${status.migrated_from_v1 ? ' · imported your earlier plaintext vault and removed it' : ''}.`;
  $<HTMLButtonElement>('vault-lock').hidden = status.locked;
  slots.innerHTML = status.locked ? '' : status.slots.length ? `<table class="man"><thead><tr><th>value_ref</th><th></th></tr></thead><tbody>${status.slots.map((name) => `<tr><td>user_saved:${esc(name)}</td><td><button class="link" data-remove="${esc(name)}">remove</button></td></tr>`).join('')}</tbody></table>` : '<p class="empty">No local credentials saved.</p>';
  slots.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((button) => button.addEventListener('click', () => { send({ type: 'athena:vault-delete', slot: button.dataset.remove! }).then(renderVault).catch(say(vaultStatus)); }));
  if (current) renderProvider(current);
}
$('vault-unlock').addEventListener('click', () => { const input = $<HTMLInputElement>('vault-passphrase'); send({ type: 'athena:vault-unlock', passphrase: input.value }).then((s) => { input.value = ''; renderVault(s); }).catch(say(lockState)); });
$('vault-lock').addEventListener('click', () => { send({ type: 'athena:vault-lock' }).then(renderVault).catch(say(lockState)); });
$('save-provider').addEventListener('click', async () => { try { await ensureProviderOriginPermission(baseUrl.value); const saved = await saveProviderSettings({ base_url: baseUrl.value, model: model.value, anthropic_format: format.checked }); if (key.value.trim()) vault = await send({ type: 'athena:vault-set-api-key', value: key.value }); renderProvider(saved); health.textContent = `Saved. ${health.textContent}`; } catch (err) { say(health)(err); } });
del.addEventListener('click', () => { send({ type: 'athena:vault-set-api-key', value: null }).then((s) => { renderVault(s); health.textContent = 'API key deleted.'; }).catch(say(health)); });
$('add-slot').addEventListener('click', () => { const nameInput = $<HTMLInputElement>('new-slot'); const valueInput = $<HTMLInputElement>('new-value'); const name = nameInput.value.trim(); if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) { vaultStatus.textContent = 'Slot names may contain letters, digits, dot, dash and underscore.'; return; } send({ type: 'athena:vault-set', slot: name, value: valueInput.value }).then((s) => { nameInput.value = ''; valueInput.value = ''; vaultStatus.textContent = `Stored user_saved:${name}`; renderVault(s); }).catch(say(vaultStatus)); });
void (async () => { try { renderVault(await send({ type: 'athena:vault-status' })); renderProvider(await readProviderSettings()); } catch (err) { say(health)(err); } })();
