# ATHENA eval corpus

Ground truth for the two metrics worth 40% of the rubric: **PII detection
precision/recall** (PRD §8) and **IoU-based redaction precision**.

Target: **≥50 annotated screens**, spread across forms, chat UIs, dashboards, and
video-call mockups. This is the longest-lead item in the build and it cannot be
compressed at the end — annotate continuously, starting now.

## Layout

```
eval/corpus/
  README.md
  annotation.schema.json         # JSON Schema for one annotation file
  labels/
    <screen_id>.labels.json      # hand-authored: WHAT is sensitive, by CSS selector
  screens/
    <screen_id>.png              # the screenshot
    <screen_id>.json             # the annotation, with measured boxes
```

## A screenshot alone is not enough

This build's detectors are DOM-based: attribute heuristics first, then regex over
extracted text. Replaying them needs the **page**, not only a picture of it. A
corpus entry whose `page_url` does not resolve to a loadable page can only be
scored for face detection, and `predict.mjs` will say so and skip it.

So a corpus screen is a screenshot **plus** the page that produced it — a saved
HTML file under `eval/fixtures/`, or a stable local URL. That is a property of
the approach rather than an oversight, and it is worth knowing before spending a
day annotating PNGs that cannot be scored.

## Two ways to produce an annotation

**By hand.** Draw the boxes, write `screens/<id>.json` directly against
`annotation.schema.json`. This is the path for screens captured from real pages.

**From labels.** For a fixture, write `labels/<id>.labels.json` naming each
sensitive item by CSS selector (and, for something inside prose, the exact text),
then run:

```
node eval/measure_labels.mjs
```

which resolves every selector to a measured bounding box, captures the PNG, and
writes `screens/<id>.json` in the same format. The judgement — what counts as
sensitive, of which type, at which tier — is still yours; only the geometry is
automated.

**Ground truth must never be derived from the detectors.** Neither path imports
anything from `extension/src/pii-detection` or `extension/src/redaction`. If it
did, the eval would be measuring the detectors against themselves and every
number would come back 1.0.

`<screen_id>` is lowercase kebab-case and stable: `bank-login-01`, `kyc-form-03`,
`video-grid-02`. The `.png` and `.json` basenames must match.

## The one hard rule

**Never put a real PII value in an annotation file.** This directory is committed
to git. Annotations record *that* something is sensitive, *what kind*, and
*where* — never *what it says*. There is no `value` field in the schema, and
that is deliberate.

For the same reason, screenshots must come from mock pages (see `eval/fixtures/`)
or from pages populated with synthetic values. Do not screenshot a real inbox,
a real bank session, or anyone's actual documents.

## How to annotate a screen

1. Capture the screen at a fixed viewport (**1280×800** unless the scenario needs
   otherwise) and save the PNG.
2. Draw a box around every sensitive item and record it as one entry.
3. One entry per **item**, not per pixel region. A card number split across four
   input boxes is four entries if there are four fields.
4. Assign `type` from the enum, and let `tier` follow PRD §4.3 — Tier 1 is
   hard-block, Tier 2 is mask-but-preserve-shape. Never invent a tier.
5. Set `modality`:
   - `text` — the sensitive thing is text/DOM (a value in a field, a rendered string)
   - `pixel` — it exists only as pixels (a face, a photographed ID card)
   Something visible both ways gets one entry with `modality: "both"`.
6. Fill `dom_path` when the item corresponds to an element. It lets us score the
   text detectors independently of the box geometry.

### Boxes

`bbox` is `[x1, y1, x2, y2]` in **viewport CSS pixels** at the annotation
viewport — top-left origin, same convention as PRD §6.2.4 and the extension's
`RawDomNode.bbox`. Not device pixels: divide by DPR if your tool reports those.

Box the **value**, not the label. In `Email: [ ada@example.org ]` the annotation
covers the field contents. `Email:` is Tier 3 structure — the server is supposed
to see it, and boxing it will register as over-redaction and cost us precision
points on the exact metric this corpus scores.

### Borderline calls

Write the reasoning in `notes` rather than guessing silently. Recurring ones:

- **Empty sensitive field** — still annotate it. A password field with no value
  is Tier 1: the detector must flag it, and a later capture may hold a value.
- **Masked-by-the-site** (`••••••`) — annotate it. The site's masking is not ours.
- **Partial values** (`•••• 4242`) — annotate. Last-four is still card data.
- **Person's name in body prose** vs. **in a form label** — the value is Tier 2
  (`person_name`); the word "Name:" is Tier 3 and is not annotated.
- **A face in a decorative stock photo** — annotate as `face`. Tier 1 does not
  care whether the person is the user.

## Scoring

`eval/run_eval.py` (M5) reads every `screens/*.json`, replays the pipeline over
the matching PNG plus its captured snapshot, and reports per-type and overall
precision/recall/F1 plus IoU-based redaction precision at 0.5.

Targets from PRD §8: Tier-1 recall ≥ 0.90, overall precision ≥ 0.80, Tier-1
redaction IoU precision ≥ 0.85.

## Validating your files

```
python -m json.tool eval/corpus/screens/<id>.json > /dev/null   # syntax
```

A schema-aware check runs in `run_eval.py`; until then, copy
`screens/_template.json` — it lists the items planted in `eval/fixtures/bank-login.html`
with the right types and tiers, and zeroed boxes for you to measure.
