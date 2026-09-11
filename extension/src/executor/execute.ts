/**
 * Action executor (PRD §6.2.9). Runs in the content script, against the REAL,
 * unredacted live DOM.
 *
 * This is the point CLAUDE.md is most emphatic about: redaction applies to what
 * crosses the network, not to what the local agent can do. The extension is the
 * user's own browser and may type a real password into a real password field.
 * What it may not do is let that value travel — which is why the value arrives
 * here already resolved from the local vault, and why nothing in this file logs
 * or returns a typed value.
 *
 * Independent selector check: the server's planner already refuses selectors it
 * was not given (PRD §6.2.8), and this refuses them again against the snapshot
 * the client itself captured. Two sides checking the same invariant is the point
 * — the server-side check protects against a confused model, this one against a
 * compromised or buggy server.
 */
import { resolvePath } from '../shared/resolve-path';

export type ExecutableVerb = 'click' | 'type' | 'focus' | 'scroll' | 'read' | 'wait';

export interface ExecutableAction {
  action: ExecutableVerb;
  selector?: string;
  /** Already resolved from the vault. Never logged, never returned. */
  value?: string;
  /** Present for display only, so the audit trail can say "typed the saved password". */
  value_ref?: string;
}

export interface ActionOutcome {
  action: ExecutableVerb;
  selector: string | null;
  ok: boolean;
  /** Populated only by `read`. Local-only — must be redacted before any resend. */
  text?: string;
  error?: string;
  duration_ms: number;
}

const NEEDS_SELECTOR = new Set<ExecutableVerb>(['click', 'type', 'focus']);
const WAIT_MS = 400;

function findOne(selector: string): Element {
  const matches = resolvePath(selector);
  if (matches.length === 0) throw new Error(`No element matches ${selector}`);
  if (matches.length > 1) throw new Error(`${matches.length} elements match ${selector} — refusing to guess`);
  return matches[0]!;
}

/**
 * Frameworks track their own value state, so assigning `.value` directly leaves
 * React and friends thinking the field is still empty. Going through the native
 * prototype setter and dispatching the events they listen for is what makes the
 * typed value stick on a real app.
 */
function setFieldValue(element: Element, value: string): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`${element.tagName.toLowerCase()} is not a text field`);
  }
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runOne(action: ExecutableAction, allowed: Set<string>): Promise<void> {
  if (NEEDS_SELECTOR.has(action.action)) {
    if (!action.selector) throw new Error(`${action.action} requires a selector`);
    if (allowed.size > 0 && !allowed.has(action.selector)) {
      throw new Error(`Refusing ${action.selector} — it was not in the snapshot sent to the server`);
    }
  }

  switch (action.action) {
    case 'click': {
      const element = findOne(action.selector!);
      element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      (element as HTMLElement).click();
      return;
    }
    case 'focus': {
      (findOne(action.selector!) as HTMLElement).focus();
      return;
    }
    case 'type': {
      const element = findOne(action.selector!);
      (element as HTMLElement).focus();
      if (action.value === undefined) throw new Error('type action arrived without a resolved value');
      setFieldValue(element, action.value);
      return;
    }
    case 'scroll': {
      if (action.selector) findOne(action.selector).scrollIntoView({ block: 'center' });
      else window.scrollBy({ top: window.innerHeight * 0.8 });
      return;
    }
    case 'wait':
      await sleep(WAIT_MS);
      return;
    case 'read':
      return;
  }
}

export async function executeActions(
  actions: ExecutableAction[],
  allowedSelectors: string[],
): Promise<ActionOutcome[]> {
  const allowed = new Set(allowedSelectors);
  const outcomes: ActionOutcome[] = [];

  for (const action of actions) {
    const started = performance.now();
    try {
      await runOne(action, allowed);
      const outcome: ActionOutcome = {
        action: action.action,
        selector: action.selector ?? null,
        ok: true,
        duration_ms: Math.round((performance.now() - started) * 100) / 100,
      };
      if (action.action === 'read' && action.selector) {
        outcome.text = (findOne(action.selector).textContent ?? '').trim().slice(0, 500);
      }
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        action: action.action,
        selector: action.selector ?? null,
        ok: false,
        // Never interpolate action.value into an error.
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Math.round((performance.now() - started) * 100) / 100,
      });
      break; // A failed step invalidates the ones after it; re-capture and re-plan.
    }
  }
  return outcomes;
}
