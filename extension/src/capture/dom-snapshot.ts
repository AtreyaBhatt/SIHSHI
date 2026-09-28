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
import { SHADOW_SEP } from '../shared/resolve-path';
import { fnv1a } from '../shared/delta';

/** What is sent. Snapshots that needed trimming are flagged `truncated`. */
const MAX_NODES = 800;
/** Cap on emitted candidates before the walk stops; bounds the trim work, not the per-element geometry cost. */
const HARD_WALK_LIMIT = 2500;
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

/** Framed documents: their pixels are on screen, their DOM is not ours to walk. */
const FRAME_TAGS = new Set(['iframe', 'frame', 'object', 'embed']);

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

type Root = Document | ShadowRoot;

function uniqueIdSelector(el: Element, root: Root): string | null {
  const id = el.getAttribute('id');
  if (!id || !isStableId(id)) return null;
  try {
    const sel = `#${CSS.escape(id)}`;
    if (root.querySelectorAll(sel).length === 1) return `${el.tagName.toLowerCase()}${sel}`;
  } catch {
    /* invalid selector — fall through to the structural path */
  }
  return null;
}

/** Path of a shadow host, cached so every node in that tree shares the prefix. */
const hostPrefix = new WeakMap<ShadowRoot, string>();

/**
 * A selector unique within `root`, prefixed with the host's own path and
 * ` >>> ` when `root` is a shadow root. `querySelector` cannot cross shadow
 * boundaries, so the hop is explicit and `resolvePath()` walks it.
 */
function cssPath(el: Element, root: Root): string {
  const prefix = root instanceof ShadowRoot ? (hostPrefix.get(root) ?? '') : '';
  const direct = uniqueIdSelector(el, root);
  if (direct) return prefix + direct;

  const parts: string[] = [];
  let cur: Element | null = el;
  const top = root instanceof Document ? root.documentElement : null;

  while (cur && cur !== top && parts.length < MAX_PATH_SEGMENTS) {
    if (cur !== el) {
      const anchor = uniqueIdSelector(cur, root);
      if (anchor) {
        parts.unshift(anchor);
        return prefix + parts.join(' > ');
      }
    }
    const node: Element = cur;
    const tag = node.tagName.toLowerCase();
    // parentNode, not parentElement: a shadow root's direct children have a
    // parentNode (the root) but no parentElement, and their siblings still count.
    const parent = node.parentNode as ParentNode | null;
    if (!parent || parent === root) {
      const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    cur = node.parentElement;
  }
  return prefix + parts.join(' > ');
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
  iframe: 'frame', frame: 'frame', object: 'frame', embed: 'frame',
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
      .map((id) => document.getElementById(id))
      .map((src) => (src && !withheld(src) ? src.textContent ?? '' : ''))
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
      const text = clip(Array.from(labels).filter((l) => !withheld(l)).map((l) => l.textContent ?? '').join(' '));
      if (text) return text;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return clip(placeholder);
  }

  for (const attr of ['alt', 'title', 'value'] as const) {
    // The accname spec takes `value` as a name only for button-like inputs. For
    // a text field it IS the sensitive content, and an unlabelled
    // <input name="fullName" value="Ada Lovelace"> would otherwise ship the
    // raw value as its "label" while the value field was tokenised.
    if (attr === 'value' && !(tag === 'input' && /^(button|submit|reset)$/.test((el as HTMLInputElement).type))) continue;
    const v = el.getAttribute(attr);
    if (v?.trim()) return clip(v);
  }

  if (tag === 'button' || tag === 'a' || tag === 'label' || tag === 'option' || /^h[1-6]$/.test(tag)) {
    // Own visible text as the name: camouflaged text names nothing.
    const text = withheld(el) ? '' : clip(el.textContent ?? '');
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
  if (!prev || !LABELLING_TAGS.has(prev.tagName.toLowerCase()) || withheld(prev)) return null;
  const text = clip(prev.textContent ?? '');
  return text || null;
}

const GROUPABLE_INPUT = new Set(['text', 'tel', 'number']);

/** One box of a split card/OTP/Aadhaar entry: a short input, or a span of 1-6 digits. */
function isDigitBox(el: Element): boolean {
  if (el.tagName === 'SPAN') return /^\d{1,6}$/.test((el.textContent ?? '').trim());
  if (el.tagName !== 'INPUT' || !GROUPABLE_INPUT.has((el as HTMLInputElement).type)) return false;
  const max = Number(el.getAttribute('maxlength'));
  return max >= 1 && max <= 6;
}

/**
 * Groups 3-8 same-tag digit boxes under one parent (`group_id` = the parent's
 * path). Single-character groups of 4+ are OTP-shaped: they borrow the
 * parent's own text and the nearest preceding heading/label as context.
 *
 * The result depends only on `parent` (and the members' shared tag), not on
 * which member `el` is — every sibling in the group gets the same id and
 * context. `cache` (one `WeakMap` per capture) makes that explicit: a parent
 * with thousands of children is scanned once instead of once per child.
 */
function digitGroup(
  el: Element,
  root: Root,
  cache: WeakMap<Element, string | null>,
): { id: string; context: string | null } | null {
  const parent = el.parentElement;
  if (!parent || (el.tagName !== 'INPUT' && el.tagName !== 'SPAN')) return null;
  const cached = cache.get(parent);
  if (cached !== undefined) return cached === null ? null : (JSON.parse(cached) as { id: string; context: string | null });

  const members = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  let result: { id: string; context: string | null } | null = null;
  if (members.length >= 3 && members.length <= 8 && members.every(isDigitBox)) {
    let context: string | null = null;
    if (members.length >= 4 && members.every((m) => m.getAttribute('maxlength') === '1')) {
      let heading: Element | null = parent.previousElementSibling;
      for (let hops = 0; heading && hops < 3 && !/^(H[1-6]|LABEL|LEGEND)$/.test(heading.tagName); hops++) {
        heading = heading.previousElementSibling;
      }
      const near = heading && /^(H[1-6]|LABEL|LEGEND)$/.test(heading.tagName) ? heading.textContent ?? '' : '';
      context = clip(`${directText(parent)} ${near}`) || null;
    }
    result = { id: cssPath(parent, root), context };
  }
  cache.set(parent, result === null ? null : JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Camouflaged text: legitimate-looking DOM that renders invisibly and exists
// only to be read by something that isn't a human — prompt injection, mostly.
// Interactive and media nodes are never subject to these checks; only plain
// text-bearing elements are.
// ---------------------------------------------------------------------------

/** Sub-2px is the floor at which a font is unreadable rather than merely small. */
const MIN_READABLE_FONT_PX = 2;
/** A box under this on both axes is not a rendered text line. */
const MIN_READABLE_BOX_PX = 2;
/** Channels within this of each other read as visually identical. */
const COLOR_MATCH_TOLERANCE = 8;

function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
}

/** 'unknown' means an image/gradient sits behind the text somewhere on the way up — the colour rule cannot speak to legibility there. */
type EffectiveBackground = { r: number; g: number; b: number } | 'unknown';

/**
 * Walks from `el` itself up to `<html>`, returning the first background-color
 * with alpha > 0. Starts at `el`'s own already-resolved style (the caller
 * holds it already, so this only pays for `getComputedStyle` from the parent
 * upward) because a node's own background paints directly behind its own
 * text. Defaults to white — the same assumption a browser's default canvas
 * makes when nothing in the ancestor chain sets one.
 *
 * A `background-image` (photo, gradient) encountered before an opaque
 * background-color makes the answer 'unknown': text can be perfectly legible
 * over imagery even when its colour matches some solid ancestor further up,
 * so the colour-match camouflage rule must not apply there.
 *
 * A colour match is then confirmed against what is actually painted at the
 * text's centre (`isCamouflaged`): a non-ancestor image/video/canvas/svg or
 * background-image there makes the answer 'unknown' too. Remaining limit:
 * `elementsFromPoint` skips `pointer-events: none` elements, so text over such
 * an image is still dropped (over-dropping, not a leak).
 */
function effectiveBackground(el: Element, style: CSSStyleDeclaration): EffectiveBackground {
  let cur: Element | null = el;
  let color = style.backgroundColor;
  let image = style.backgroundImage;
  while (cur) {
    if (image && image !== 'none') return 'unknown';
    const bg = parseRgb(color);
    if (bg && bg.a > 0) return bg;
    cur = cur.parentElement;
    if (!cur) break;
    const parentStyle = getComputedStyle(cur);
    color = parentStyle.backgroundColor;
    image = parentStyle.backgroundImage;
  }
  return { r: 255, g: 255, b: 255 };
}

/** Opacity multiplied down the ancestor chain; memoised per capture. */
let opacityCache = new WeakMap<Element, number>();
function effectiveOpacity(el: Element, style?: CSSStyleDeclaration): number {
  const hit = opacityCache.get(el);
  if (hit !== undefined) return hit;
  const own = parseFloat((style ?? getComputedStyle(el)).opacity || '1');
  const parent = el.parentElement;
  const value = own === 0 || !parent ? own : own * effectiveOpacity(parent);
  opacityCache.set(el, value);
  return value;
}

const PAINTED_MEDIA = new Set(['img', 'video', 'canvas', 'svg']);

/** True when something other than `el` and its ancestors paints imagery at the text's centre. */
function imageryUnder(el: Element, rect: DOMRect): boolean {
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const other of root.elementsFromPoint(x, y)) {
    if (other === el || other.contains(el)) continue;
    if (PAINTED_MEDIA.has(other.tagName.toLowerCase()) || other instanceof SVGElement) return true;
    if (getComputedStyle(other).backgroundImage !== 'none') return true;
  }
  return false;
}

/**
 * The capture-time camouflage rules (screen-reader-only clip-path/clip text
 * is deliberately NOT a rule of its own: that text is kept unless one of these
 * also applies): sub-2px font, sub-2px box, an effective (ancestor-multiplied)
 * opacity of 0, a fully transparent text colour, or a text colour matching the
 * effective background with no imagery painted under the text. Heuristic.
 */
function isCamouflaged(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
  if (parseFloat(style.fontSize || '16') < MIN_READABLE_FONT_PX) return true;
  if (rect.width < MIN_READABLE_BOX_PX && rect.height < MIN_READABLE_BOX_PX) return true;
  if (effectiveOpacity(el, style) === 0) return true;
  const fg = parseRgb(style.color);
  if (!fg) return false;
  if (fg.a === 0) return true;
  const bg = effectiveBackground(el, style);
  if (bg === 'unknown') return false;
  const match =
    Math.abs(fg.r - bg.r) < COLOR_MATCH_TOLERANCE &&
    Math.abs(fg.g - bg.g) < COLOR_MATCH_TOLERANCE &&
    Math.abs(fg.b - bg.b) < COLOR_MATCH_TOLERANCE;
  return match && !imageryUnder(el, rect);
}

/**
 * Label sources and interactive names are text the model reads too. Each
 * camouflaged element is counted in `hidden_dropped` once, however many
 * nodes it would have labelled.
 */
let camouflagedSeen = new WeakSet<Element>();
let camouflagedCount = 0;
function withheld(el: Element): boolean {
  if (!isCamouflaged(el, getComputedStyle(el), el.getBoundingClientRect())) return false;
  if (!camouflagedSeen.has(el)) {
    camouflagedSeen.add(el);
    camouflagedCount++;
  }
  return true;
}

function srcFile(el: Element): string | null {
  const src = el.getAttribute('src');
  if (!src) return null;
  const name = src.split(/[?#]/)[0]!.split('/').pop() ?? '';
  return name ? name.slice(0, 80) : null;
}

/**
 * A digest of the image URL, not of its bytes: a same-URL image whose bytes
 * changed (server-side swap, cache-busted by headers only) is NOT detected as
 * changed, so DeltaVision will reuse its old face boxes; the full-frame face
 * pass still runs every step. Long (e.g. data:) URLs hash only their first
 * 2048 chars plus their length.
 */
function srcHash(el: Element): string | null {
  const current = (el as { currentSrc?: string }).currentSrc || el.getAttribute('src');
  if (!current) return null;
  return fnv1a(current.length > 2048 ? `${current.slice(0, 2048)}|${current.length}` : current);
}

/**
 * Visual-effect digest for a media node (local only, never serialized):
 * FNV-1a of filter/opacity/visibility/clip-path/transform on the node itself
 * and on every ancestor up to body that has a non-default filter or opacity
 * < 1. Removing a `filter: blur()` from a photo, or from a wrapper around it,
 * changes no text, box or src — this is what makes DeltaVision see it.
 */
function effectsHash(el: Element, style: CSSStyleDeclaration): string {
  const fx = (s: CSSStyleDeclaration): string => `${s.filter}|${s.opacity}|${s.visibility}|${s.clipPath}|${s.transform}`;
  const parts = [fx(style)];
  for (let cur = el.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
    const s = getComputedStyle(cur);
    if ((s.filter && s.filter !== 'none') || parseFloat(s.opacity || '1') < 1) parts.push(fx(s));
    if (cur === document.body) break;
  }
  return fnv1a(parts.join(';'));
}

/**
 * `<img>` load state — `'1'` once the image has actually finished decoding
 * with real pixels, `'0'` otherwise (still loading, or errored to a 0x0
 * natural size). Every other media tag has no comparable "loaded" concept, so
 * it stays null. An image that finishes loading between two capture steps
 * must be seen as changed even though its src/box/alt never moved.
 */
function loadedState(el: Element, tag: string): string | null {
  if (tag !== 'img') return null;
  const img = el as HTMLImageElement;
  return img.complete && img.naturalWidth > 0 ? '1' : '0';
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
  let hiddenDropped = 0;
  opacityCache = new WeakMap();
  camouflagedSeen = new WeakSet();
  camouflagedCount = 0;
  const digitGroupCache = new WeakMap<Element, string | null>();

  const visit = (el: Element, root: Root): void => {
    const tag = el.tagName.toLowerCase();
    const elRole = role(el, tag);
    const interactive = isInteractive(el, tag, elRole);
    const media: RawDomNode['media'] = FRAME_TAGS.has(tag) ? 'iframe' : MEDIA_TAGS.has(tag) ? (tag as RawDomNode['media']) : null;
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
          // Camouflage rules apply only to plain text — never to interactive
          // controls or media regions, which the agent must still see and act on.
          if (!interactive && !media && text && isCamouflaged(el, style, rect)) {
            if (!camouflagedSeen.has(el)) {
              camouflagedSeen.add(el);
              hiddenDropped++;
            }
            return;
          }

          const inputType = tag === 'input' ? ((el as HTMLInputElement).type?.toLowerCase() ?? 'text') : null;
          const { value, omitted } = readValue(el, tag, inputType);
          const group = digitGroup(el, root, digitGroupCache);

          nodes.push({
            path: cssPath(el, root),
            tag,
            role: elRole,
            label: accessibleName(el, tag),
            text: text || null,
            context_label: siblingLabel(el) ?? group?.context ?? null,
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
              class: el.getAttribute('class')?.slice(0, 80) ?? null,
              src_file: media ? srcFile(el) : null,
              src_hash: media ? srcHash(el) : null,
              loaded: loadedState(el, tag),
              fx: media ? effectsHash(el, style) : null,
            },
            bbox: toBBox(rect),
            interactive,
            media,
            group_id: group?.id ?? null,
          });
        } else if (directText(el)) {
          // Already dropped by the pre-existing opacity:0/visibility:hidden
          // check; counted here so the model knows this much text vanished.
          if (!camouflagedSeen.has(el)) {
            camouflagedSeen.add(el);
            hiddenDropped++;
          }
        }
      }
    }
  };

  const walk = (parent: Element | ShadowRoot, root: Root): void => {
    for (const child of Array.from(parent.children)) {
      if (truncated) return;
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue; // prunes the whole subtree — the cheapest possible win
      visit(child, root);
      if (nodes.length >= HARD_WALK_LIMIT) {
        truncated = true;
        return;
      }
      // Open shadow roots are part of what the user sees; closed ones are not
      // reachable and are a documented ceiling.
      const shadow = child.shadowRoot;
      if (shadow) {
        hostPrefix.set(shadow, cssPath(child, root) + SHADOW_SEP);
        walk(shadow, shadow);
      }
      walk(child, root);
    }
  };

  const body = document.body ?? document.documentElement;
  visit(body, document);
  walk(body, document);

  // Interactive and media nodes are what the agent acts on and what the face
  // detector scans; on an oversized page they must survive the cut even when
  // they sit at the bottom of the document. Only text nodes are trimmed, so a
  // page with more than MAX_NODES interactive elements sends them all and the
  // budget is exceeded — the agent cannot act on what it was not told about.
  let kept = nodes;
  let unscanned: BBox[] = [];
  if (nodes.length > MAX_NODES) {
    const order = new Map(nodes.map((n, i) => [n, i]));
    const priority = nodes.filter((n) => n.interactive || n.media);
    const rest = nodes.filter((n) => !(n.interactive || n.media));
    const dropped = rest.slice(Math.max(0, MAX_NODES - priority.length));
    if (dropped.length > 0) {
      truncated = true;
      unscanned = dropped.map((n) => n.bbox);
    }
    kept = [...priority, ...rest.slice(0, Math.max(0, MAX_NODES - priority.length))];
    kept.sort((a, b) => order.get(a)! - order.get(b)!); // back to document order
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
    nodes: kept,
    truncated,
    unscanned,
    hidden_dropped: hiddenDropped + camouflagedCount,
    timings: { dom_walk_ms: Math.round((performance.now() - start) * 100) / 100 },
  };
}
