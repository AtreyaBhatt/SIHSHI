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
import type { ActionVerb, KeyName } from '../shared/schema';

/** Page-level verbs. `navigate` and `go_back` are handled by the service worker. */
export type ExecutableVerb = Exclude<ActionVerb, 'navigate' | 'go_back'>;

export interface ExecutableAction {
  action: ExecutableVerb;
  selector?: string;
  /** Already resolved from the vault. Never logged, never returned. */
  value?: string;
  /** Present for display only, so the audit trail can say "typed the saved password". */
  value_ref?: string;
  option?: string;
  key?: KeyName;
  direction?: 'up' | 'down';
}

export interface ActionOutcome {
  action: ActionVerb;
  selector: string | null;
  ok: boolean;
  error?: string;
  duration_ms: number;
}

const NEEDS_SELECTOR = new Set<ExecutableVerb>(['click', 'type', 'select', 'hover']);
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

const KEY_CODES: Record<KeyName, string> = {
  Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Space: 'Space',
};

function keyboardInit(key: KeyName): KeyboardEventInit {
  return { key: key === 'Space' ? ' ' : key, code: KEY_CODES[key], bubbles: true, cancelable: true };
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

function moveFocus(from: Element | null): void {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.getClientRects().length > 0);
  const index = from ? all.indexOf(from as HTMLElement) : -1;
  const next = all[(index + 1) % all.length];
  next?.focus();
}

function pressKey(target: Element, key: KeyName): void {
  const init = keyboardInit(key);
  const down = target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  if (!down) return; // the page handled it
  if (key === 'Enter') {
    const form = (target as HTMLElement).closest('form');
    if (form) form.requestSubmit();
  } else if (key === 'Tab') {
    moveFocus(target);
  }
}

function selectOption(element: Element, option: string): void {
  if (!(element instanceof HTMLSelectElement)) throw new Error(`${element.tagName.toLowerCase()} is not a select`);
  const wanted = option.trim().toLowerCase();
  const match = Array.from(element.options).find((o) => o.label.trim().toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted)
    ?? Array.from(element.options).find((o) => o.value.toLowerCase() === wanted);
  if (!match) throw new Error(`No option matches "${option}" in ${element.options.length} options`);
  element.value = match.value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function hover(element: Element): void {
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' && type !== 'pointerenter', cancelable: true, view: window }));
  }
}

async function runOne(action: ExecutableAction, allowed: Set<string>): Promise<void> {
  if (NEEDS_SELECTOR.has(action.action) && !action.selector) throw new Error(`${action.action} requires a selector`);
  // Every selector, on every verb: the allowlist is the snapshot the client sent.
  // An empty allowlist is not "no restriction" — it means the client sent no
  // paths at all, so nothing can be in it. Fail closed.
  if (action.selector && !allowed.has(action.selector)) {
    throw new Error(`Refusing ${action.selector} — it was not in the snapshot sent to the provider`);
  }

  switch (action.action) {
    case 'click': {
      const element = findOne(action.selector!);
      element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      // A real pointer click focuses the target via mousedown before the click
      // event fires; el.click() alone does not, so a synthetic click restores
      // that ordering explicitly (needed for text inputs — buttons focus either way).
      (element as HTMLElement).focus?.();
      (element as HTMLElement).click();
      return;
    }
    case 'type': {
      const element = findOne(action.selector!);
      (element as HTMLElement).focus();
      if (action.value === undefined) throw new Error('type action arrived without a resolved value');
      setFieldValue(element, '');
      setFieldValue(element, action.value);
      return;
    }
    case 'select': {
      if (!action.option) throw new Error('select requires an option');
      selectOption(findOne(action.selector!), action.option);
      return;
    }
    case 'key': {
      if (!action.key) throw new Error('key action arrived without a key');
      const target = action.selector ? findOne(action.selector) : (document.activeElement ?? document.body);
      if (action.selector) (target as HTMLElement).focus();
      pressKey(target, action.key);
      return;
    }
    case 'hover': {
      const element = findOne(action.selector!);
      element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      hover(element);
      return;
    }
    case 'scroll': {
      if (action.selector) findOne(action.selector).scrollIntoView({ block: 'center' });
      else window.scrollBy({ top: window.innerHeight * 0.8 * (action.direction === 'up' ? -1 : 1) });
      return;
    }
    case 'wait':
      await sleep(WAIT_MS);
      return;
  }
}

export async function executeActions(
  actions: ExecutableAction[],
  allowedSelectors: string[],
  expectedOrigin: string | null = null,
): Promise<ActionOutcome[]> {
  const allowed = new Set(allowedSelectors);
  const outcomes: ActionOutcome[] = [];

  for (const action of actions) {
    const started = performance.now();
    try {
      // Re-checked per action, not per batch: a click can navigate same-tab and
      // the next action would otherwise run on whatever page arrived.
      if (expectedOrigin && location.origin !== expectedOrigin) {
        throw new Error(`Page origin changed to ${location.origin}; stopping before ${action.action}`);
      }
      await runOne(action, allowed);
      outcomes.push({ action: action.action, selector: action.selector ?? null, ok: true, duration_ms: Math.round((performance.now() - started) * 100) / 100 });
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
