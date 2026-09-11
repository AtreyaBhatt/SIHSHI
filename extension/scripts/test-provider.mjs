import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'athena-provider-'));
const bundle = join(temp, 'agent-client.mjs');
const permissions = new Set(['https://openrouter.ai/*', 'https://provider.example/*']);
const cookies = new Map();
const removed = [];
const storage = {};

globalThis.chrome = {
  storage: { local: { get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])), set: async (values) => Object.assign(storage, values) } },
  permissions: {
    contains: async ({ origins }) => origins.every((origin) => permissions.has(origin)),
    request: async ({ origins }) => { origins.forEach((origin) => permissions.add(origin)); return true; },
  },
  cookies: {
    get: async ({ url, name }) => cookies.get(`${new URL(url).origin}:${name}`) ?? null,
    set: async (details) => { cookies.set(`${new URL(details.url).origin}:${details.name}`, { ...details, domain: new URL(details.url).hostname }); return { ...details, value: details.value, domain: new URL(details.url).hostname }; },
    remove: async ({ url, name }) => { const key = `${new URL(url).origin}:${name}`; cookies.delete(key); removed.push(key); return { url, name }; },
  },
};

await build({ entryPoints: ['src/background/agent-client.ts'], outfile: join(temp, 'agent-client.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
await build({ entryPoints: ['src/shared/provider-settings.ts'], outfile: join(temp, 'provider-settings.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
const client = await import(`file://${join(temp, 'agent-client.mjs')}`);
const settingsApi = await import(`file://${join(temp, 'provider-settings.mjs')}`);
const { readProviderSettings, saveProviderSettings } = settingsApi;
const { requestProviderPlan } = client;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const request = {
  session_id: 'session-1', task_instruction: 'Click the safe button', screenshot_redacted: 'data:image/png;base64,REDACTED_PIXELS',
  dom_summary: [{ path: 'button#safe', role: 'button', label: 'Continue', value: null }, { path: 'input#password', role: 'textbox', label: 'Password', value: '[REDACTED:PASSWORD]' }],
  redaction_manifest: [{ id: 'PASSWORD_1', type: 'password', tier: 1, bbox: null, dom_path: 'input#password', masking: 'blackbox', detector: 'test', confidence: 1 }],
  prior_actions: [], truncated: false,
};

const defaults = await readProviderSettings();
assert(defaults.base_url === 'https://openrouter.ai/api/v1', 'default provider URL');
assert(defaults.model === 'openai/gpt-4o-mini', 'default provider model');
assert(defaults.anthropic_format === false, 'Anthropic format defaults unchecked');
assert(defaults.api_key_present === false, 'default has no API key');
const saved = await saveProviderSettings({ base_url: defaults.base_url, model: defaults.model, anthropic_format: false, api_key: 'secret-provider-key' });
assert(saved.api_key_present && !JSON.stringify(saved).includes('secret-provider-key'), 'key is absent from returned settings');
const cookie = cookies.get('https://openrouter.ai:athena_api_key');
assert(cookie.httpOnly && cookie.sameSite === 'strict' && cookie.path === '/__athena_config/', 'cookie security attributes');
const changed = await saveProviderSettings({ base_url: 'https://provider.example/v1', model: 'stub-model', anthropic_format: false }, defaults.base_url);
assert(!changed.api_key_present && removed.includes('https://openrouter.ai:athena_api_key'), 'old provider cookie removed on base URL change');

let observed;
const openai = await requestProviderPlan(request, { base_url: 'https://provider.example/v1', model: 'stub-model', anthropic_format: false }, 'openai-secret', async (url, options) => {
  observed = { url, options };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reasoning_summary: 'Click the visible button.', actions: [{ action: 'click', selector: 'button#safe' }], requires_client_secret: false }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
});
assert(observed.url.endsWith('/chat/completions') && observed.options.headers.authorization === 'Bearer openai-secret', 'OpenAI endpoint and auth');
assert(!observed.options.body.includes('openai-secret') && observed.options.body.includes('REDACTED_PIXELS'), 'OpenAI payload excludes key and uses redacted screenshot');
assert(openai.actions.length === 1, 'valid OpenAI action survives');

const anthropic = await requestProviderPlan(request, { base_url: 'https://provider.example/v1', model: 'stub-model', anthropic_format: true }, 'anthropic-secret', async (url, options) => {
  observed = { url, options };
  return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ reasoning_summary: 'No safe credential action.', actions: [], requires_client_secret: false }) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
});
assert(observed.url.endsWith('/messages') && observed.options.headers['x-api-key'] === 'anthropic-secret', 'Anthropic endpoint and auth');
assert(!observed.options.body.includes('anthropic-secret'), 'Anthropic payload excludes key');
assert(anthropic.actions.length === 0, 'valid Anthropic empty plan');

const rejected = await requestProviderPlan(request, { base_url: 'https://provider.example/v1', model: 'stub-model', anthropic_format: false }, 'safe-key', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reasoning_summary: 'Bad output.', actions: [{ action: 'click', selector: 'button#invented' }, { action: 'type', selector: 'input#password', value: '[REDACTED:PASSWORD]' }], requires_client_secret: false }) } }] }), { status: 200 }));
assert(rejected.actions.length === 0 && (rejected.guardrail_rejections?.length ?? 0) === 2, 'guardrails reject invented and Tier-1 literal actions');

console.log('PASS provider settings, cookie lifecycle, direct formats, and response guardrails');
await rm(temp, { recursive: true, force: true });
