import type { AgentAction, AgentRequest, AgentResponse, ActionVerb } from '../shared/schema';

const ACTION_VERBS = new Set<ActionVerb>(['click', 'type', 'focus', 'scroll', 'read', 'wait']);
const NEEDS_SELECTOR = new Set<ActionVerb>(['click', 'type', 'focus']);
const ACTION_FIELDS = new Set(['action', 'selector', 'value', 'value_ref']);
const PLAN_FIELDS = new Set(['reasoning_summary', 'actions', 'requires_client_secret']);
const VALUE_REF = /^user_saved:[A-Za-z0-9_.-]{1,64}$/;
const MARKER = /\[(?:REDACTED:[^\]]+|[A-Z][A-Z0-9]*_\d+)\]/;

export function emptyProviderResponse(request: AgentRequest, rejection: string): AgentResponse {
  return {
    session_id: request.session_id,
    reasoning_summary: 'The provider output was not a valid executable plan; no actions were executed.',
    actions: [],
    requires_client_secret: false,
    guardrail_rejections: [rejection],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parsePlan(raw: unknown, request: AgentRequest): AgentResponse {
  if (!isRecord(raw) || !hasOnlyFields(raw, PLAN_FIELDS)
    || typeof raw.reasoning_summary !== 'string'
    || !raw.reasoning_summary.trim()
    || !Array.isArray(raw.actions)
    || typeof raw.requires_client_secret !== 'boolean') {
    return emptyProviderResponse(request, 'provider output was not a valid action plan');
  }

  const allowedPaths = new Set(request.dom_summary.map((node) => node.path));
  const tier1Paths = new Set(
    request.redaction_manifest
      .filter((entry) => entry.tier === 1 && entry.dom_path)
      .map((entry) => entry.dom_path!),
  );
  const actions: AgentAction[] = [];
  const rejected: string[] = [];

  raw.actions.forEach((candidate, index) => {
    const label = `action[${index}]`;
    if (!isRecord(candidate) || !hasOnlyFields(candidate, ACTION_FIELDS)) {
      rejected.push(`${label}: action has an unsupported shape`);
      return;
    }

    const actionValue = candidate.action;
    if (typeof actionValue !== 'string' || !ACTION_VERBS.has(actionValue as ActionVerb)) {
      rejected.push(`${label}: unknown action verb`);
      return;
    }
    const action = actionValue as ActionVerb;
    const selector = candidate.selector;
    const value = candidate.value;
    const valueRef = candidate.value_ref;

    if (selector !== undefined && typeof selector !== 'string') {
      rejected.push(`${label} ${action}: selector must be a string`);
      return;
    }
    if (NEEDS_SELECTOR.has(action) && !selector) {
      rejected.push(`${label} ${action}: requires a selector`);
      return;
    }
    if (typeof selector === 'string' && !allowedPaths.has(selector)) {
      rejected.push(`${label} ${action}: selector was not in dom_summary`);
      return;
    }
    if (value !== undefined && typeof value !== 'string') {
      rejected.push(`${label} ${action}: value must be a string`);
      return;
    }
    if (valueRef !== undefined && typeof valueRef !== 'string') {
      rejected.push(`${label} ${action}: value_ref must be a string`);
      return;
    }
    if (typeof value === 'string' && MARKER.test(value)) {
      rejected.push(`${label} ${action}: value echoes a redaction marker`);
      return;
    }
    if (typeof valueRef === 'string' && !VALUE_REF.test(valueRef)) {
      rejected.push(`${label} ${action}: value_ref is not a user_saved reference`);
      return;
    }
    if (action === 'type') {
      const hasValue = value !== undefined;
      const hasValueRef = valueRef !== undefined;
      if (hasValue === hasValueRef) {
        rejected.push(`${label} ${action}: needs exactly one of value / value_ref`);
        return;
      }
      if (hasValue && tier1Paths.has(selector!)) {
        rejected.push(`${label} ${action}: tier 1 fields must use value_ref`);
        return;
      }
    }

    const kept: AgentAction = { action };
    if (typeof selector === 'string') kept.selector = selector;
    if (typeof value === 'string') kept.value = value;
    if (typeof valueRef === 'string') kept.value_ref = valueRef;
    actions.push(kept);
  });

  return {
    session_id: request.session_id,
    reasoning_summary: raw.reasoning_summary,
    actions,
    requires_client_secret: actions.some((action) => Boolean(action.value_ref)),
    ...(rejected.length ? { guardrail_rejections: rejected } : {}),
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
