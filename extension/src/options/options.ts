/**
 * Settings for the server origin and the local credential vault.
 *
 * Stored values are shown as slot names with a masked length, never as text. The
 * point of `value_ref` is that a secret has exactly one home; echoing it into a
 * settings page for convenience would put a copy in the DOM of a page that any
 * screenshot — including one taken by this very extension — could capture.
 */
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from '../background/agent-client';
import { readVault, writeVault, type Vault } from '../shared/vault';
import { api } from '../shared/browser';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const serverInput = $<HTMLInputElement>('server-url');
const healthLine = $('health');
const slotsEl = $('slots');
const vaultStatus = $('vault-status');

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function renderVault(): Promise<void> {
  const vault = await readVault();
  const slots = Object.keys(vault).sort();
  slotsEl.innerHTML = slots.length
    ? `<table class="man"><thead><tr><th>value_ref</th><th>stored</th><th></th></tr></thead><tbody>${slots
        .map(
          (slot) => `<tr>
            <td>user_saved:${esc(slot)}</td>
            <td>${'•'.repeat(Math.min(vault[slot]!.length, 16))} (${vault[slot]!.length} chars)</td>
            <td><button class="link" data-remove="${esc(slot)}">remove</button></td>
          </tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="empty">No credentials stored. The executor will refuse any value_ref it cannot resolve.</p>';

  for (const button of slotsEl.querySelectorAll<HTMLButtonElement>('[data-remove]')) {
    button.addEventListener('click', async () => {
      const next: Vault = { ...(await readVault()) };
      delete next[button.dataset.remove!];
      await writeVault(next);
      vaultStatus.textContent = `Removed ${button.dataset.remove}.`;
      await renderVault();
    });
  }
}

$('save-url').addEventListener('click', async () => {
  await setServerUrl(serverInput.value.trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL);
  healthLine.textContent = 'Saved.';
});

$('test-url').addEventListener('click', async () => {
  healthLine.textContent = 'Checking…';
  try {
    const reply = (await api.runtime.sendMessage({ type: 'ppva:check-health' })) as
      | { ok: true; data: { provider: string; ingress_policy: string; server_url: string } }
      | { ok: false; error: string };
    healthLine.textContent = reply.ok
      ? `Reachable — provider "${reply.data.provider}", ingress policy "${reply.data.ingress_policy}".`
      : `Unreachable: ${reply.error}`;
  } catch (err) {
    healthLine.textContent = `Unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
});

$('add-slot').addEventListener('click', async () => {
  const slotInput = $<HTMLInputElement>('new-slot');
  const valueInput = $<HTMLInputElement>('new-value');
  const slot = slotInput.value.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(slot)) {
    vaultStatus.textContent = 'Slot names may contain letters, digits, dot, dash and underscore.';
    return;
  }
  await writeVault({ ...(await readVault()), [slot]: valueInput.value });
  slotInput.value = '';
  valueInput.value = '';
  vaultStatus.textContent = `Stored user_saved:${slot}.`;
  await renderVault();
});

void (async () => {
  serverInput.value = await getServerUrl();
  await renderVault();
})();
