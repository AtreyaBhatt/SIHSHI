import { deleteProviderApiKey, getProviderSettings, saveProviderSettings, type ProviderSettings } from '../background/agent-client';
import { readVault, writeVault } from '../shared/vault';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const format = $<HTMLInputElement>('anthropic-format');
const baseUrl = $<HTMLInputElement>('provider-base-url');
const model = $<HTMLInputElement>('provider-model');
const key = $<HTMLInputElement>('provider-api-key');
const del = $<HTMLButtonElement>('delete-api-key');
const health = $('provider-health');
const slots = $('slots');
const vaultStatus = $('vault-status');
let current: ProviderSettings | null = null;

function esc(value: string): string { return value.replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!); }
function renderProvider(settings: ProviderSettings): void {
  current = settings; format.checked = settings.anthropic_format; baseUrl.value = settings.base_url; model.value = settings.model; key.value = '';
  key.placeholder = settings.api_key_present ? 'API key stored — leave blank to keep it' : 'Enter provider API key'; del.hidden = !settings.api_key_present;
  health.textContent = settings.api_key_present ? `Configured · ${settings.anthropic_format ? 'anthropic' : 'openai'} · ${settings.base_url}` : 'Not configured · add an API key to enable planning.';
}
async function refreshProvider(): Promise<void> { renderProvider(await getProviderSettings()); }
async function renderVault(): Promise<void> {
  const vault = await readVault(); const names = Object.keys(vault).sort();
  slots.innerHTML = names.length ? `<table class="man"><thead><tr><th>value_ref</th><th>stored</th><th></th></tr></thead><tbody>${names.map((name) => `<tr><td>user_saved:${esc(name)}</td><td>${'•'.repeat(Math.min(vault[name]!.length, 16))} (${vault[name]!.length} chars)</td><td><button class="link" data-remove="${esc(name)}">remove</button></td></tr>`).join('')}</tbody></table>` : '<p class="empty">No local credentials saved.</p>';
  slots.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((button) => button.addEventListener('click', async () => { const next = { ...(await readVault()) }; delete next[button.dataset.remove!]; await writeVault(next); await renderVault(); }));
}
$('save-provider').addEventListener('click', async () => { try { const saved = await saveProviderSettings({ base_url: baseUrl.value, model: model.value, anthropic_format: format.checked, api_key: key.value }, current?.base_url); renderProvider(saved); health.textContent = `Saved. ${health.textContent}`; } catch (err) { health.textContent = err instanceof Error ? err.message : 'Could not save provider settings.'; } });
del.addEventListener('click', async () => { if (!current) return; try { await deleteProviderApiKey(current.base_url); await refreshProvider(); health.textContent = 'API key deleted.'; } catch (err) { health.textContent = err instanceof Error ? err.message : 'Could not delete the API key.'; } });
$('add-slot').addEventListener('click', async () => { const nameInput = $<HTMLInputElement>('new-slot'); const valueInput = $<HTMLInputElement>('new-value'); const name = nameInput.value.trim(); if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) { vaultStatus.textContent = 'Slot names may contain letters, digits, dot, dash and underscore.'; return; } await writeVault({ ...(await readVault()), [name]: valueInput.value }); nameInput.value = ''; valueInput.value = ''; vaultStatus.textContent = `Stored user_saved:${name}`; await renderVault(); });
void (async () => { try { await refreshProvider(); await renderVault(); } catch (err) { health.textContent = err instanceof Error ? err.message : 'Could not read local settings.'; } })();
