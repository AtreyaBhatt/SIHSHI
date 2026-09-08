#!/usr/bin/env python3
"""Scores the redaction pipeline against the labelled corpus (PRD §8).

Two different questions get two different matching rules, because conflating
them produces a flattering number for one and an unfair one for the other:

  DETECTION — "did we find the sensitive thing?" A prediction matches a
  ground-truth item when the types agree and the boxes correspond, where
  correspond means IoU >= 0.5 OR the ground-truth box is essentially contained
  in the prediction. The containment clause is not generosity: this build's
  pixel geometry is node-granular, so an email inside a paragraph is predicted
  with the paragraph's box. It found the email. That is a detection hit.

  REDACTION PRECISION — "did we redact only what we should?" Strict IoU >= 0.5
  against ground truth, no containment clause. Here the paragraph-sized box for
  a one-line email is exactly the over-redaction the metric exists to catch, and
  it is counted against us.

Run:
    node eval/predict.mjs && python3 eval/run_eval.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).parent
SCREENS = HERE / "corpus/screens"
PREDICTIONS = HERE / "results/predictions.json"

IOU_MATCH = 0.5
CONTAINMENT_MATCH = 0.9

# PRD §8, "target numbers to aim for".
TARGETS = [
    ("Tier-1 detection recall", "tier1_recall", 0.90),
    ("Overall detection precision", "overall_precision", 0.80),
    ("Tier-1 redaction precision (IoU)", "tier1_redaction_precision", 0.85),
]

Box = list[float]


def area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def intersection(a: Box, b: Box) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def iou(a: Box, b: Box) -> float:
    inter = intersection(a, b)
    union = area(a) + area(b) - inter
    return inter / union if union > 0 else 0.0


def containment(inner: Box, outer: Box) -> float:
    """How much of `inner` lies inside `outer`."""
    a = area(inner)
    return intersection(inner, outer) / a if a > 0 else 0.0


@dataclass
class Counts:
    tp: int = 0
    fp: int = 0
    fn: int = 0

    @property
    def precision(self) -> float:
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else float("nan")

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else float("nan")

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if p == p and r == r and p + r > 0 else float("nan")


@dataclass
class Report:
    overall: Counts = field(default_factory=Counts)
    by_tier: dict[int, Counts] = field(default_factory=lambda: defaultdict(Counts))
    by_type: dict[str, Counts] = field(default_factory=lambda: defaultdict(Counts))
    misses: list[str] = field(default_factory=list)
    spurious: list[str] = field(default_factory=list)
    redaction_hits: dict[int, Counts] = field(default_factory=lambda: defaultdict(Counts))
    over_redacted: list[str] = field(default_factory=list)
    timings: list[dict] = field(default_factory=list)
    screens: int = 0
    unscorable: list[str] = field(default_factory=list)


def score_screen(screen: dict, prediction: dict, report: Report) -> None:
    truth = screen["annotations"]
    predictions = sorted(prediction["detections"], key=lambda d: -d.get("confidence", 0))
    claimed: set[int] = set()

    # --- detection ---------------------------------------------------------
    for pred in predictions:
        best_index, best_score = None, 0.0
        for index, item in enumerate(truth):
            if index in claimed or item["type"] != pred["type"]:
                continue
            score = max(iou(item["bbox"], pred["bbox"]), 0.0)
            if score < IOU_MATCH and containment(item["bbox"], pred["bbox"]) >= CONTAINMENT_MATCH:
                score = IOU_MATCH  # counts as found; geometry is judged separately
            if score >= IOU_MATCH and score > best_score:
                best_index, best_score = index, score
        if best_index is None:
            report.overall.fp += 1
            report.by_tier[pred["tier"]].fp += 1
            report.by_type[pred["type"]].fp += 1
            report.spurious.append(
                f"{screen['screen_id']} {pred['type']} via {pred.get('detector', '?')} at {pred['node_path']}"
            )
        else:
            claimed.add(best_index)
            report.overall.tp += 1
            report.by_tier[pred["tier"]].tp += 1
            report.by_type[pred["type"]].tp += 1

    for index, item in enumerate(truth):
        if index not in claimed:
            report.overall.fn += 1
            report.by_tier[item["tier"]].fn += 1
            report.by_type[item["type"]].fn += 1
            note = item.get("notes", "")
            report.misses.append(
                f"{screen['screen_id']} {item['id']:>4} {item['type']:<14} T{item['tier']}"
                + (f"  — {note.split('.')[0]}." if note else "")
            )

    # --- redaction precision (pixels actually masked) ----------------------
    for entry in prediction["manifest"]:
        if not entry.get("bbox"):
            continue
        tier = entry["tier"]
        best = max((iou(item["bbox"], entry["bbox"]) for item in truth), default=0.0)
        if best >= IOU_MATCH:
            report.redaction_hits[tier].tp += 1
        else:
            report.redaction_hits[tier].fp += 1
            closest = max(truth, key=lambda i: iou(i["bbox"], entry["bbox"]), default=None)
            report.over_redacted.append(
                f"{screen['screen_id']} {entry['type']:<14} T{tier} masked "
                f"{int(entry['bbox'][2] - entry['bbox'][0])}x{int(entry['bbox'][3] - entry['bbox'][1])} px, "
                f"best IoU {best:.2f}"
                + (f" against {closest['id']}" if closest and best > 0 else " (no overlap with any labelled item)")
            )

    report.timings.append({"screen": screen["screen_id"], **prediction["timings"]})
    report.screens += 1


def fmt(value: float) -> str:
    return "   n/a" if value != value else f"{value:6.3f}"


def main() -> int:
    if not PREDICTIONS.exists():
        print(f"No predictions at {PREDICTIONS}. Run: node eval/predict.mjs", file=sys.stderr)
        return 2

    payload = json.loads(PREDICTIONS.read_text())
    screens = sorted(p for p in SCREENS.glob("*.json") if not p.name.startswith("_"))
    if not screens:
        print(f"No annotated screens in {SCREENS}.", file=sys.stderr)
        return 2

    report = Report()
    for path in screens:
        screen = json.loads(path.read_text())
        prediction = payload["screens"].get(screen["screen_id"])
        if prediction is None or "unscorable" in prediction:
            report.unscorable.append(
                f"{screen['screen_id']}: {prediction['unscorable'] if prediction else 'no prediction'}"
            )
            continue
        score_screen(screen, prediction, report)

    truth_count = report.overall.tp + report.overall.fn
    print("PPVA evaluation")
    print(f"threshold {payload['threshold']} · {report.screens} screen(s) · {truth_count} labelled item(s)\n")

    print("PII DETECTION")
    print(f"{'':<22}{'TP':>4}{'FP':>5}{'FN':>5}   precision  recall      F1")
    rows = [("overall", report.overall)]
    rows += [(f"tier {t}", report.by_tier[t]) for t in sorted(report.by_tier)]
    for label, c in rows:
        print(f"{label:<22}{c.tp:>4}{c.fp:>5}{c.fn:>5}     {fmt(c.precision)}  {fmt(c.recall)}  {fmt(c.f1)}")
    print()
    for pii_type in sorted(report.by_type):
        c = report.by_type[pii_type]
        print(f"  {pii_type:<20}{c.tp:>4}{c.fp:>5}{c.fn:>5}     {fmt(c.precision)}  {fmt(c.recall)}  {fmt(c.f1)}")

    print("\nREDACTION PRECISION  (pixel regions, strict IoU >= 0.5)")
    all_red = Counts()
    for tier in sorted(report.redaction_hits):
        c = report.redaction_hits[tier]
        all_red.tp += c.tp
        all_red.fp += c.fp
        print(f"  tier {tier}          {c.tp:>4} on-target {c.fp:>4} off-target     {fmt(c.precision)}")
    print(f"  {'overall':<15}{all_red.tp:>4} on-target {all_red.fp:>4} off-target     {fmt(all_red.precision)}")

    if report.misses:
        print("\nFALSE NEGATIVES (labelled but not detected)")
        for line in report.misses:
            print(f"  {line}")
    if report.spurious:
        print("\nFALSE POSITIVES (detected but not labelled)")
        for line in report.spurious:
            print(f"  {line}")
    if report.over_redacted:
        print("\nOFF-TARGET PIXEL REGIONS (redacted area does not match a labelled box)")
        for line in report.over_redacted:
            print(f"  {line}")

    print("\nLOCAL PIPELINE LATENCY  (no screenshot, no network)")
    for t in report.timings:
        total = t["capture_ms"] + t["detect_ms"] + t["redact_ms"]
        print(
            f"  {t['screen']:<16} capture {t['capture_ms']:6.2f}  detect {t['detect_ms']:6.2f}  "
            f"redact {t['redact_ms']:6.2f}  total {total:6.2f} ms"
        )

    metrics = {
        "tier1_recall": report.by_tier[1].recall,
        "overall_precision": report.overall.precision,
        "tier1_redaction_precision": report.redaction_hits[1].precision,
    }
    print("\nTARGETS (PRD §8)")
    failed = 0
    for label, key, target in TARGETS:
        value = metrics[key]
        ok = value == value and value >= target
        failed += 0 if ok else 1
        print(f"  {label:<36} {fmt(value)}  target >= {target:.2f}   {'PASS' if ok else 'BELOW'}")

    if report.unscorable:
        print("\nUNSCORABLE SCREENS")
        for line in report.unscorable:
            print(f"  {line}")

    print(
        f"\nCAVEAT: {report.screens} screen(s), {truth_count} labelled items. PRD §8 calls for >= 50 "
        "screens.\nThese are fixtures written by the same author as the detectors, so they measure "
        "internal\nconsistency far better than they measure generalisation. Treat every number above "
        "as an\nupper bound, not an estimate."
    )

    (HERE / "results/metrics.json").write_text(
        json.dumps(
            {
                "threshold": payload["threshold"],
                "screens": report.screens,
                "labelled_items": truth_count,
                "detection": {
                    "overall": vars(report.overall),
                    "by_tier": {str(k): vars(v) for k, v in report.by_tier.items()},
                    "by_type": {k: vars(v) for k, v in report.by_type.items()},
                },
                "metrics": {k: (None if v != v else round(v, 4)) for k, v in metrics.items()},
                "timings": report.timings,
            },
            indent=2,
        )
        + "\n"
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
