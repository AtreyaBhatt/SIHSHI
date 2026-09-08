/**
 * Serializes the visible DOM into a RawSnapshot.
 *
 * Two invariants, both from CLAUDE.md:
 *
 *  1. This NEVER mutates the live page. Everything here reads; the snapshot is a
 *     detached copy. Redaction (M2) operates on that copy, never on what the user
 *     is looking at.
 *
 *  2. Detector cost ordering starts here. Elements are filtered cheapest-first —
 *     tag/attribute checks, then getBoundingClientRect, then getComputedStyle —
 *     because getComputedStyle forces style resolution and is the expensive call.
 *     Client resource utilisation is 20% of the rubric (PRD §8); this ordering is
 *     the difference between a snapshot that costs ~10ms and one that costs ~100ms.
 */
import type { BBox, RawDomNode, RawSnapshot } from '../shared/schema';
import { SCHEMA_VERSION } from '../shared/schema';

/** Bounds payload size and walk latency. Snapshots that hit this are flagged `truncated`. */
const MAX_NODES = 400;
const MAX_PATH_SEGMENTS = 8;

/**
 * Text clipping is a payload-size bound, and it must never be mistaken for a
 * privacy control. The invariant that matters is that we only ever send what we
 * scanned — the detectors run over exactly this clipped string, so nothing
 * unscanned can leave. What clipping costs is context accuracy (PRD G3), and
 * setting it too low quietly hides prose from the detectors *and* from the
 * server, which reads as "no PII found" when it was really "no PII looked at".
 *
 * 600 covers ordinary paragraph text. Labels stay short because an accessible
 * name that long is a page bug, not a label.
 */
const MAX_TEXT_CHARS = 600;
const MAX_LABEL_CHARS = 200;

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title', 'br', 'hr',
]);

const INTERACTIVE_TAGS = new Set([
  'input', 'select', 'textarea', 'button', 'a', 'summary', 'details', 'option', 'label',
]);

const MEDIA_TAGS = new Set(['img', 'video', 'canvas', 'svg', 'picture']);

/** Elements that label a sibling rather than themselves. */
const LABELLING_TAGS = new Set(['dt', 'th', 'label', 'strong', 'b']);

const INTERACTIVE_ROLE = /^(button|link|textbox|searchbox|checkbox|radio|combobox|listbox|menuitem|menuitemcheckbox|menuitemradio|option|tab|switch|slider|spinbutton)$/;

function clip(s: string, limit: number = MAX_LABEL_CHARS): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** Text belonging to this element directly — not to its descendants. Keeps one node per visible string. */
function directText(el: Element): string {
  let out = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue ?? '';
  }
  return clip(out, MAX_TEXT_CHARS);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Rejects framework-generated ids. A path built on `#\:r7\:` or `#a3f9c2e1b` is
 * useless across a re-render, and the action planner (M4) can only target
 * selectors we send it — so an unstable path becomes a failed action later.
 */
function isStableId(id: string): boolean {
  if (!id || id.length > 48) return false;
  if (!/^[A-Za-z_][\w-]*$/.test(id)) return false;
  if (/^[0-9a-f]{8,}$/i.test(id)) return false;
  const digits = (id.match(/\d/g) ?? []).length;
  return digits / id.length <= 0.5;
}

function uniqueIdSelector(el: Element): string | null {
  const id = el.getAttribute('id');
  if (!id || !isStableId(id)) return null;
  try {
    const sel = `#${CSS.escape(id)}`;
    if (document.querySelectorAll(sel).length === 1) return `${el.tagName.toLowerCase()}${sel}`;
  } catch {
    /* invalid selector — fall through to the structural path */
  }
  return null;
}

function cssPath(el: Element): string {
  const direct = uniqueIdSelector(el);
  if (direct) return direct;

  const parts: string[] = [];
  let cur: Element | null = el;

  while (cur && cur !== document.documentElement && parts.length < MAX_PATH_SEGMENTS) {
    if (cur !== el) {
      const anchor = uniqueIdSelector(cur);
      if (anchor) {
        parts.unshift(anchor);
        return parts.join(' > ');
      }
    }
    const node: Element = cur;
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    cur = parent;
  }
  return parts.join(' > ');
}

// ---------------------------------------------------------------------------
// Roles and accessible names
// ---------------------------------------------------------------------------

const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  img: 'img',
  video: 'video',
  form: 'form',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  table: 'table',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  option: 'option',
  summary: 'button',
  dialog: 'dialog',
};

const INPUT_ROLE: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  file: 'button',
  hidden: 'none',
};

function role(el: Element, tag: string): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0] ?? null;
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text';
    return INPUT_ROLE[type] ?? 'textbox';
  }
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  return IMPLICIT_ROLE[tag] ?? null;
}

/** Simplified accname. Not spec-complete — enough for the server to identify a field. */
function accessibleName(el: Element, tag: string): string | null {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const clipped = clip(text);
    if (clipped) return clipped;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return clip(ariaLabel);

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    const labels = el.labels;
    if (labels && labels.length > 0) {
      const text = clip(Array.from(labels).map((l) => l.textContent ?? '').join(' '));
      if (text) return text;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return clip(placeholder);
  }

  for (const attr of ['alt', 'title', 'value'] as const) {
    if (attr === 'value' && tag !== 'input') continue;
    const v = el.getAttribute(attr);
    if (v?.trim()) return clip(v);
  }

  if (tag === 'button' || tag === 'a' || tag === 'label' || tag === 'option' || /^h[1-6]$/.test(tag)) {
    const text = clip(el.textContent ?? '');
    if (text) return text;
  }
  return null;
}

/**
 * The label sitting beside a value that carries no name of its own —
 * `<dt>Account number</dt><dd>5010…</dd>`. Definition-list and table-row
 * structure is the cheapest classification signal on a page after the input
 * attributes themselves.
 */
function siblingLabel(el: Element): string | null {
  const prev = el.previousElementSibling;
  if (!prev || !LABELLING_TAGS.has(prev.tagName.toLowerCase())) return null;
  const text = clip(prev.textContent ?? '');
  return text || null;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function isInteractive(el: Element, tag: string, elRole: string | null): boolean {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (el.hasAttribute('tabindex') || el.hasAttribute('contenteditable')) return true;
  if (el.hasAttribute('onclick')) return true;
  return elRole !== null && INTERACTIVE_ROLE.test(elRole);
}

function toBBox(rect: DOMRect): BBox {
  return [
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.right),
    Math.round(rect.bottom),
  ];
}

/**
 * Reads the value unless the field is a password.
 *
 * A password field is already identified with total certainty by its `type`
 * attribute, so copying the secret into the snapshot adds no detection signal —
 * it only creates one more place the value exists. M2 will emit
 * `[REDACTED:PASSWORD]` for these from the DOM heuristic alone.
 */
function readValue(el: Element, tag: string, inputType: string | null): {
  value: string | null;
  omitted: 'password' | null;
} {
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return { value: null, omitted: null };
  if (inputType === 'password') {
    const raw = (el as HTMLInputElement).value;
    return { value: null, omitted: raw ? 'password' : null };
  }
  const v = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  return { value: v ? clip(v) : null, omitted: null };
}

export function captureDomSnapshot(): RawSnapshot {
  const start = performance.now();
  const nodes: RawDomNode[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let truncated = false;

  const root = document.body ?? document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      // FILTER_REJECT prunes the whole subtree — the cheapest possible win.
      return SKIP_TAGS.has((node as Element).tagName.toLowerCase())
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });

  let el: Element | null = root;
  while (el) {
    const tag = el.tagName.toLowerCase();
    const elRole = role(el, tag);
    const interactive = isInteractive(el, tag, elRole);
    const media = MEDIA_TAGS.has(tag) ? (tag as RawDomNode['media']) : null;
    const text = interactive || media ? '' : directText(el);

    // Cheap rejection first: nothing to say about this element at all.
    if (interactive || media || text) {
      const rect = el.getBoundingClientRect();
      const onScreen =
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < vh && rect.left < vw;

      if (onScreen) {
        // Only now do we pay for style resolution.
        const style = getComputedStyle(el);
        const shown =
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          parseFloat(style.opacity || '1') > 0;

        if (shown) {
          const inputType = tag === 'input' ? ((el as HTMLInputElement).type?.toLowerCase() ?? 'text') : null;
          const { value, omitted } = readValue(el, tag, inputType);

          nodes.push({
            path: cssPath(el),
            tag,
            role: elRole,
            label: accessibleName(el, tag),
            text: text || null,
            context_label: siblingLabel(el),
            value,
            value_omitted: omitted,
            input_type: inputType,
            attrs: {
              id: el.getAttribute('id'),
              name: el.getAttribute('name'),
              autocomplete: el.getAttribute('autocomplete'),
              placeholder: el.getAttribute('placeholder'),
              aria_label: el.getAttribute('aria-label'),
              alt: el.getAttribute('alt'),
              title: el.getAttribute('title'),
              inputmode: el.getAttribute('inputmode'),
              maxlength: el.getAttribute('maxlength'),
            },
            bbox: toBBox(rect),
            interactive,
            media,
          });

          if (nodes.length >= MAX_NODES) {
            truncated = true;
            break;
          }
        }
      }
    }
    el = walker.nextNode() as Element | null;
  }

  return {
    schema_version: SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    page_url: location.href,
    page_title: document.title,
    viewport: {
      width: vw,
      height: vh,
      device_pixel_ratio: window.devicePixelRatio,
      scroll_x: Math.round(window.scrollX),
      scroll_y: Math.round(window.scrollY),
    },
    nodes,
    truncated,
    timings: { dom_walk_ms: Math.round((performance.now() - start) * 100) / 100 },
  };
}
