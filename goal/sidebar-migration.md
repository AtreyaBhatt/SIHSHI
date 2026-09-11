# Goal — move the extension UI from a toolbar popup to a side panel

## Why

The demo script in the deck (Slide 8) ends with the user approving an action and
then watching the real page complete it. A toolbar popup is destroyed the moment
it loses focus, so the approval UI disappears at exactly the step it exists to
show. A side panel stays beside the portal.

`design/aavaran-sidebar/` is the design of record: a right-hand assistant panel
with a current-page card, a privacy summary, an ask box, a sanitized preview with
a redaction legend, an agent plan with an approval gate, and a privacy activity
log. `build.py` emits it once for 400 px and once for 320 px so the two artboards
cannot drift; the extension implements the same markup fluidly across that range.

## What changes

- The extension's user surface becomes `chrome.sidePanel`, not `action.default_popup`.
- The panel is built from the design's markup and CSS, with Instrument Sans
  self-hosted rather than linked from Google Fonts.
- Every number in the panel comes from the existing pipeline — capture,
  detection, redaction manifest, plan, execution — not from artboard copy.
- The popup surface is deleted rather than kept alongside.

## What does not change

Capture, perception, PII detection, redaction, the executor, the vault, the
server contract, and the diff viewer. The service-worker message protocol is
transport-agnostic and already carries everything the panel needs.

## Acceptance

- `npm run typecheck` and `npm run build` pass; `dist/manifest.json` declares the panel.
- The panel renders real pipeline output: real tier counts, real detection rows,
  the real redaction manifest and request body, the real plan actions with
  `value_ref` slots unresolved.
- Execution is gated by a review modal — the deck's "sensitive actions require
  user confirmation".
- The panel survives a tab switch and re-renders its page context.
- Verified by loading the built extension in Chromium and probing the panel API,
  plus a render pass against data produced by the real redaction engine.

## Known limits, stated up front

- `activeTab` is granted per tab on invocation; the panel cannot capture a tab the
  user has not invoked it on, and says so instead of pretending.
- The vault is a demo vault, unencrypted at rest (see `src/shared/vault.ts`).
- The design's wordmark is AAVARAN while the manifest, README and PRD still say
  PPVA. The panel follows the design; unifying the name across the repo is a
  separate decision.
