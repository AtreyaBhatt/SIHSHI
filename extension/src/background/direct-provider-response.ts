import type { AgentAction, AgentRequest, AgentResponse, ActionVerb, ActionRisk, KeyName, PiiType } from '../shared/schema';
import { ACTION_VERBS, KEY_NAMES, NEEDS_SELECTOR, RESOLVABLE_TIER1, TIER_BY_TYPE } from '../shared/schema';

const ACTION_FIELDS = new Set(['action', 'selector', 'value', 'value_ref', 'value_token', 'option', 'key', 'direction', 'url', 'risk']);
const PLAN_FIELDS = new Set(['reasoning_summary', 'actions', 'requires_client_secret', 'done', 'result']);
const VALUE_REF = /^user_saved:[A-Za-z0-9_.-]{1,64}$/;
const MARKER = /\[(?:REDACTED:[^\]]+|[A-Z][A-Z0-9_]*_\d+)\]/;
const HTTP_URL = /^https?:\/\/\S+$/;
const TOKEN = /^\[[A-Z][A-Z0-9_]*_\d+\]$/;

export function emptyProviderResponse(request: AgentRequest, rejection: string): AgentResponse {
  return {
    session_id: request.session_id,
    reasoning_summary: 'The provider output was not a valid executable plan; no actions were executed.',
    actions: [],
    requires_client_secret: false,
    guardrail_rejections: [rejection],
    done: false,
    result: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Every rule here is mirrored in server/app/action_planner.py. Rejections are
 * dropped, not thrown: one bad action must not lose a good plan, and the
 * reasons travel back so the refusal is visible in the panel.
 */
function constrainAction(candidate: unknown, index: number, allowedPaths: Set<string>, tier1Paths: Set<string>, roles: Map<string, string | null>, redactedPaths: Set<string>, tokenIds: Map<string, PiiType>, targetTypes: Set<string>, availableRefs: Set<string>): { action?: AgentAction; rejection?: string } {
  const label = `action[${index}]`;
  if (!isRecord(candidate) || !hasOnlyFields(candidate, ACTION_FIELDS)) return { rejection: `${label}: action has an unsupported shape` };
  if (typeof candidate.action !== 'string' || !ACTION_VERBS.has(candidate.action)) return { rejection: `${label}: unknown action verb ${JSON.stringify(candidate.action)}` };
  const verb = candidate.action as ActionVerb;
  const tag = `${label} ${verb}`;
  const { selector, value, value_ref: valueRef, value_token: valueToken, option, key, direction, url, risk } = candidate;

  if (!optionalString(selector) || !optionalString(value) || !optionalString(valueRef) || !optionalString(valueToken) || !optionalString(option) || !optionalString(url)) {
    return { rejection: `${tag}: string fields must be strings` };
  }
  if (NEEDS_SELECTOR.has(verb) && !selector) return { rejection: `${tag}: requires a selector` };
  if (selector !== undefined && !allowedPaths.has(selector)) return { rejection: `${tag}: selector was not in dom_summary` };
  if (risk !== undefined && risk !== 'routine' && risk !== 'sensitive') return { rejection: `${tag}: risk must be routine or sensitive` };

  if (verb === 'select' && !option) return { rejection: `${tag}: requires an option` };
  if (verb === 'key' && (typeof key !== 'string' || !KEY_NAMES.has(key))) return { rejection: `${tag}: key must be one of ${[...KEY_NAMES].join(', ')}` };
  if (verb === 'scroll' && direction !== undefined && direction !== 'up' && direction !== 'down') return { rejection: `${tag}: direction must be up or down` };
  if (verb === 'navigate' && (!url || !HTTP_URL.test(url))) return { rejection: `${tag}: requires an http(s) url` };

  if (verb !== 'type' && (value !== undefined || valueRef !== undefined)) return { rejection: `${tag}: value / value_ref only apply to type` };
  if (value !== undefined && MARKER.test(value)) return { rejection: `${tag}: value echoes a redaction marker` };
  if (valueRef !== undefined && !VALUE_REF.test(valueRef)) return { rejection: `${tag}: value_ref is not a user_saved reference` };

  if (verb !== 'type' && (value !== undefined || valueRef !== undefined || valueToken !== undefined)) return { rejection: `${tag}: value / value_ref / value_token only apply to type` };
  if (valueToken !== undefined) {
    if (!TOKEN.test(valueToken)) return { rejection: `${tag}: value_token must look like [TYPE_N]` };
    const id = valueToken.slice(1, -1);
    const type = tokenIds.get(id);
    if (!type || !(RESOLVABLE_TIER1.has(type) || TIER_BY_TYPE[type] === 2)) return { rejection: `${tag}: value_token is not a token from this request` };
    if (!targetTypes.has(`${selector}\n${type}`)) return { rejection: `${tag}: value_token type does not match the target field` };
  }
  if (valueRef !== undefined && availableRefs.size > 0 && !availableRefs.has(valueRef)) return { rejection: `${tag}: value_ref names a slot the user has not stored` };
  if (verb === 'type') {
    const sources = [value, valueRef, valueToken].filter((v) => v !== undefined).length;
    if (sources !== 1) return { rejection: `${tag}: needs exactly one of value / value_ref / value_token` };
    if (value !== undefined && tier1Paths.has(selector!)) return { rejection: `${tag}: tier 1 fields must use value_ref or value_token` };
  }

  // Risk floor: these pause in approve-sensitive whatever the model said.
  const floor = verb === 'navigate'
    || (verb === 'key' && key === 'Enter')
    || (verb === 'click' && ['button', 'link'].includes(roles.get(selector!) ?? ''))
    || (verb === 'type' && redactedPaths.has(selector!))
    || valueRef !== undefined || valueToken !== undefined;
  const action: AgentAction = { action: verb, risk: floor ? 'sensitive' : ((risk as ActionRisk | undefined) ?? 'routine') };
  if (selector !== undefined) action.selector = selector;
  if (value !== undefined) action.value = value;
  if (valueRef !== undefined) action.value_ref = valueRef;
  if (valueToken !== undefined) action.value_token = valueToken;
  if (option !== undefined) action.option = option;
  if (verb === 'key') action.key = key as KeyName;
  if (verb === 'scroll' && direction !== undefined) action.direction = direction as 'up' | 'down';
  if (url !== undefined) action.url = url;
  return { action };
}

function parsePlan(raw: unknown, request: AgentRequest): AgentResponse {
  if (!isRecord(raw) || !hasOnlyFields(raw, PLAN_FIELDS)
    || typeof raw.reasoning_summary !== 'string'
    || !raw.reasoning_summary.trim()
    || !Array.isArray(raw.actions)
    || typeof raw.requires_client_secret !== 'boolean'
    || (raw.done !== undefined && typeof raw.done !== 'boolean')
    || (raw.result !== undefined && raw.result !== null && typeof raw.result !== 'string')) {
    return emptyProviderResponse(request, 'provider output was not a valid action plan');
  }

  const allowedPaths = new Set(request.dom_summary.map((node) => node.path));
  const tier1Paths = new Set(request.redaction_manifest.filter((e) => e.tier === 1 && e.dom_path).map((e) => e.dom_path!));
  const roles = new Map(request.dom_summary.map((node) => [node.path, node.role]));
  const redactedPaths = new Set(request.redaction_manifest.filter((e) => e.dom_path).map((e) => e.dom_path!));
  // Firewall-minted tokens mark values the cascade missed; they are masked, never typeable.
  const tokenIds = new Map(request.redaction_manifest.filter((e) => !e.detector.startsWith('firewall:') && !e.detector.startsWith('group:')).map((e) => [e.id, e.type]));
  // A token may only fill a field the client declared as holding that same type.
  const targetTypes = new Set(request.redaction_manifest.filter((e) => e.dom_path).map((e) => `${e.dom_path}\n${e.type}`));
  const availableRefs = new Set(request.available_refs ?? []);
  const actions: AgentAction[] = [];
  const rejected: string[] = [];
  raw.actions.forEach((candidate, index) => {
    const { action, rejection } = constrainAction(candidate, index, allowedPaths, tier1Paths, roles, redactedPaths, tokenIds, targetTypes, availableRefs);
    if (action) actions.push(action);
    if (rejection) rejected.push(rejection);
  });

  return {
    session_id: request.session_id,
    reasoning_summary: raw.reasoning_summary,
    actions,
    requires_client_secret: actions.some((action) => Boolean(action.value_ref) || Boolean(action.value_token)),
    ...(rejected.length ? { guardrail_rejections: rejected } : {}),
    done: raw.done === true,
    result: typeof raw.result === 'string' ? raw.result : null,
  };
}

export function extractProviderText(payload: unknown, anthropic: boolean): string | null {
  if (!isRecord(payload)) return null;
  if (anthropic) {
    if (!Array.isArray(payload.content)) return null;
    const text = payload.content
      .filter((block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('');
    return text || null;
  }

  if (!Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || !isRecord(payload.choices[0].message)) return null;
  const content = payload.choices[0].message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  return text || null;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : trimmed;
}

export function normalizeProviderResponse(
  payload: unknown,
  anthropic: boolean,
  request: AgentRequest,
): AgentResponse {
  const text = extractProviderText(payload, anthropic);
  if (!text) return emptyProviderResponse(request, 'provider response did not contain text content');

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return emptyProviderResponse(request, 'provider text was not valid JSON');
  }
  return parsePlan(parsed, request);
}
