import { api } from './browser';

export const PROVIDER_BASE_URL_KEY = 'athena:provider-base-url';
export const PROVIDER_MODEL_KEY = 'athena:provider-model';
export const PROVIDER_ANTHROPIC_FORMAT_KEY = 'athena:provider-anthropic-format';
export const DEFAULT_PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_PROVIDER_MODEL = 'openai/gpt-4o-mini';

export interface ProviderSettings {
  base_url: string;
  model: string;
  anthropic_format: boolean;
}

export interface SaveProviderSettings {
  base_url: string;
  model?: string;
  anthropic_format: boolean;
}

export function normalizeProviderBaseUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provider base URL must be an absolute http:// or https:// URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Provider base URL must use http:// or https://.');
  if (url.username || url.password || url.search || url.hash || !url.hostname) throw new Error('Provider base URL must not contain credentials, query, or fragment.');
  return value;
}

async function requirePermission(baseUrl: string, request = false): Promise<void> {
  const origins = [`${new URL(baseUrl).origin}/*`];
  if (await api.permissions.contains({ origins })) return;
  if (request && await api.permissions.request({ origins })) return;
  throw new Error('The extension does not have permission for this provider origin.');
}

export async function ensureProviderOriginPermission(baseUrl: string): Promise<void> {
  await requirePermission(normalizeProviderBaseUrl(baseUrl), true);
}

export async function readProviderSettings(): Promise<ProviderSettings> {
  const stored = await api.storage.local.get([PROVIDER_BASE_URL_KEY, PROVIDER_MODEL_KEY, PROVIDER_ANTHROPIC_FORMAT_KEY]);
  const base_url = normalizeProviderBaseUrl(typeof stored?.[PROVIDER_BASE_URL_KEY] === 'string' ? stored[PROVIDER_BASE_URL_KEY] : DEFAULT_PROVIDER_BASE_URL);
  const model = typeof stored?.[PROVIDER_MODEL_KEY] === 'string' && stored[PROVIDER_MODEL_KEY].trim() ? stored[PROVIDER_MODEL_KEY].trim() : DEFAULT_PROVIDER_MODEL;
  return { base_url, model, anthropic_format: Boolean(stored?.[PROVIDER_ANTHROPIC_FORMAT_KEY]) };
}

export async function saveProviderSettings(settings: SaveProviderSettings): Promise<ProviderSettings> {
  const base_url = normalizeProviderBaseUrl(settings.base_url);
  await api.storage.local.set({ [PROVIDER_BASE_URL_KEY]: base_url, [PROVIDER_MODEL_KEY]: settings.model?.trim() || DEFAULT_PROVIDER_MODEL, [PROVIDER_ANTHROPIC_FORMAT_KEY]: Boolean(settings.anthropic_format) });
  return readProviderSettings();
}
