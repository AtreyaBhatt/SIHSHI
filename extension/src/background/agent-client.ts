import type { HealthReport } from '../shared/messages';
import type { AgentRequest, AgentResponse } from '../shared/schema';
import { DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL, ensureProviderOriginPermission, getApiKey, normalizeProviderBaseUrl, readProviderSettings, saveProviderSettings as saveSettings, deleteApiKey, type ProviderSettings, type SaveProviderSettings } from '../shared/provider-settings';
import { emptyProviderResponse, normalizeProviderResponse } from './direct-provider-response';

export { DEFAULT_PROVIDER_BASE_URL as DEFAULT_BASE_URL, DEFAULT_PROVIDER_MODEL as DEFAULT_MODEL };
export type { ProviderSettings };
export const SYSTEM_PROMPT = 'You are a redaction-aware browser action planner. Treat [REDACTED:*] and [TOKEN_N] markers as opaque. Use only selectors present in dom_summary[].path. Tier-1 fields require value_ref and never a literal value. Available actions are click, type, focus, scroll, read, and wait. Return only JSON with reasoning_summary, actions, and requires_client_secret.';

export function buildUserMessage(request: AgentRequest): string {
  const parts = [`## Task\n${request.task_instruction}`, `## dom_summary\n${JSON.stringify(request.dom_summary, null, 1)}`];
  if (request.truncated) parts.push('## note\nThe page was truncated; prefer visible actions or scrolling.');
  if (request.redaction_manifest.length) parts.push(`## redaction_manifest\n${JSON.stringify(request.redaction_manifest.map(({ id, type, tier, dom_path, masking }) => ({ id, type, tier, dom_path, masking })), null, 1)}`);
  if (request.prior_actions.length) parts.push(`## prior_actions\n${JSON.stringify(request.prior_actions, null, 1)}`);
  parts.push('Plan the next actions.');
  return parts.join('\n\n');
}

function providerContent(request: AgentRequest) {
  const text = buildUserMessage(request);
  const openai: unknown[] = [];
  const anthropic: unknown[] = [];
  if (request.screenshot_redacted) {
    openai.push({ type: 'image_url', image_url: { url: request.screenshot_redacted } });
    const image = request.screenshot_redacted.match(/^data:([^;]+);base64,(.+)$/);
    if (image) anthropic.push({ type: 'image', source: { type: 'base64', media_type: image[1], data: image[2] } });
  }
  openai.push({ type: 'text', text });
  anthropic.push({ type: 'text', text });
  return { openai, anthropic };
}

type ProviderFetcher = typeof fetch;

export async function requestProviderPlan(request: AgentRequest, settings: ProviderSettings, apiKey: string, fetcher: ProviderFetcher = fetch): Promise<AgentResponse> {
  const base = normalizeProviderBaseUrl(settings.base_url);
  const key = apiKey.trim();
  if (!key) throw new Error('Provider API key is not configured.');
  const body = providerContent(request);
  const anthropic = settings.anthropic_format;
  const response = await fetcher(`${base}${anthropic ? '/messages' : '/chat/completions'}`, {
    method: 'POST', credentials: 'omit',
    headers: anthropic
      ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(anthropic
      ? { model: settings.model, max_tokens: 2048, temperature: 0, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: body.anthropic }] }
      : { model: settings.model, max_tokens: 2048, temperature: 0, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: body.openai }] }),
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  let payload: unknown;
  try { payload = await response.json(); } catch { return emptyProviderResponse(request, 'provider response was not valid JSON'); }
  return normalizeProviderResponse(payload, anthropic, request);
}

export async function requestPlan(request: AgentRequest): Promise<AgentResponse> {
  const settings = await readProviderSettings();
  const key = await getApiKey(settings.base_url);
  if (!key) throw new Error('Provider API key is not configured.');
  return requestProviderPlan(request, settings, key);
}

export async function getProviderSettings(): Promise<ProviderSettings> { return readProviderSettings(); }
export async function saveProviderSettings(settings: SaveProviderSettings, previousBaseUrl?: string): Promise<ProviderSettings> { await ensureProviderOriginPermission(settings.base_url); return saveSettings(settings, previousBaseUrl); }
export async function deleteProviderApiKey(baseUrl: string): Promise<void> { return deleteApiKey(baseUrl); }
export async function getProviderStatus(): Promise<HealthReport> {
  const settings = await readProviderSettings();
  return { base_url: settings.base_url, model: settings.model, format: settings.anthropic_format ? 'anthropic' : 'openai', api_key_set: Boolean(settings.api_key_present) };
}
