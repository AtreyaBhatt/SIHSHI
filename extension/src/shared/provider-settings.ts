import { api } from './browser';

export const PROVIDER_BASE_URL_KEY = 'athena:provider-base-url';
export const PROVIDER_MODEL_KEY = 'athena:provider-model';
export const PROVIDER_ANTHROPIC_FORMAT_KEY = 'athena:provider-anthropic-format';
export const API_KEY_COOKIE_NAME = 'athena_api_key';
export const DEFAULT_PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_PROVIDER_MODEL = 'openai/gpt-4o-mini';
const COOKIE_PATH = '/__athena_config/';
const COOKIE_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

export interface ProviderSettings {
  base_url: string;
  model: string;
  anthropic_format: boolean;
  api_key_present?: boolean;
}

export interface SaveProviderSettings {
  base_url: string;
  model?: string;
  anthropic_format: boolean;
  api_key?: string;
}

export function normalizeProviderBaseUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provider base URL must be an absolute http:// or https:// URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Provider base URL must use http:// or https://.');
  if (url.username || url.password || url.search || url.hash || !url.hostname) throw new Error('Provider base URL must not contain credentials, query, or fragment.');
  return value;
}

function cookieDetails(baseUrl: string): chrome.cookies.CookieDetails {
  const url = new URL(baseUrl);
  return { url: `${url.origin}${COOKIE_PATH}`, name: API_KEY_COOKIE_NAME };
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

export async function getApiKey(baseUrl: string): Promise<string | null> {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  await requirePermission(normalized);
  return (await api.cookies.get(cookieDetails(normalized)))?.value || null;
}

export async function setApiKey(baseUrl: string, value: string): Promise<void> {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  await requirePermission(normalized);
  const url = new URL(normalized);
  const cookie = await api.cookies.set({
    url: `${url.origin}${COOKIE_PATH}`, name: API_KEY_COOKIE_NAME, value: value.trim(), path: COOKIE_PATH,
    httpOnly: true, sameSite: 'strict', secure: url.protocol === 'https:',
    expirationDate: Math.floor(Date.now() / 1000) + COOKIE_LIFETIME_SECONDS,
  });
  if (!cookie) throw new Error('Provider API key could not be saved.');
}

export async function hasApiKey(baseUrl: string): Promise<boolean> {
  try { return Boolean(await getApiKey(baseUrl)); } catch { return false; }
}

export async function deleteApiKey(baseUrl: string): Promise<void> {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  await requirePermission(normalized);
  const url = new URL(normalized);
  await api.cookies.remove({ url: `${url.origin}${COOKIE_PATH}`, name: API_KEY_COOKIE_NAME });
}

export async function readProviderSettings(): Promise<ProviderSettings> {
  const stored = await api.storage.local.get([PROVIDER_BASE_URL_KEY, PROVIDER_MODEL_KEY, PROVIDER_ANTHROPIC_FORMAT_KEY]);
  const base_url = normalizeProviderBaseUrl(typeof stored?.[PROVIDER_BASE_URL_KEY] === 'string' ? stored[PROVIDER_BASE_URL_KEY] : DEFAULT_PROVIDER_BASE_URL);
  const model = typeof stored?.[PROVIDER_MODEL_KEY] === 'string' && stored[PROVIDER_MODEL_KEY].trim() ? stored[PROVIDER_MODEL_KEY].trim() : DEFAULT_PROVIDER_MODEL;
  return { base_url, model, anthropic_format: Boolean(stored?.[PROVIDER_ANTHROPIC_FORMAT_KEY]), api_key_present: await hasApiKey(base_url) };
}

export async function saveProviderSettings(settings: SaveProviderSettings, previousBaseUrl?: string): Promise<ProviderSettings> {
  const base_url = normalizeProviderBaseUrl(settings.base_url);
  if (previousBaseUrl && normalizeProviderBaseUrl(previousBaseUrl) !== base_url) await deleteApiKey(previousBaseUrl);
  if (settings.api_key?.trim()) await setApiKey(base_url, settings.api_key);
  await api.storage.local.set({ [PROVIDER_BASE_URL_KEY]: base_url, [PROVIDER_MODEL_KEY]: settings.model?.trim() || DEFAULT_PROVIDER_MODEL, [PROVIDER_ANTHROPIC_FORMAT_KEY]: Boolean(settings.anthropic_format) });
  return readProviderSettings();
}
