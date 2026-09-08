"""PII patterns for the ingress check.

This is an INDEPENDENT reimplementation of the client's detectors, not a shared
module, and that is the point. PRD §6.2.6 exists to catch a buggy or bypassed
client; sharing one implementation between the thing being checked and the thing
doing the checking would mean a single bug defeats both layers at once.

Only self-validating formats live here. The client's context-gated rules (a bare
digit run is an account number only given a nearby label) cannot be re-derived
from a sanitized payload without the context that was deliberately stripped, so
attempting them server-side produces false rejections, not defense.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from .schemas import PiiType


def luhn(digits: str) -> bool:
    if not digits.isdigit():
        return False
    total = 0
    double = False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6), (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8), (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2), (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4), (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2), (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0), (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5), (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)


def verhoeff(digits: str) -> bool:
    """The checksum UIDAI uses for Aadhaar."""
    if not digits.isdigit():
        return False
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][ord(ch) - 48]]
    return c == 0


def is_aadhaar(raw: str) -> bool:
    d = re.sub(r"\D", "", raw)
    return len(d) == 12 and d[0] in "23456789" and verhoeff(d)


def is_payment_card(raw: str) -> bool:
    """Luhn plus an issuer-digit check — Luhn alone passes ~10% of random runs."""
    d = re.sub(r"\D", "", raw)
    return len(d) in (13, 14, 15, 16, 19) and d[0] in "3456" and luhn(d)


@dataclass(frozen=True)
class Pattern:
    type: PiiType
    name: str
    regex: re.Pattern[str]
    validate: Callable[[str], bool] | None = None


PATTERNS: tuple[Pattern, ...] = (
    Pattern("email", "email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    Pattern("card_number", "card_number+luhn", re.compile(r"\b(?:\d[ -]?){12,18}\d\b"), is_payment_card),
    Pattern("aadhaar", "aadhaar+verhoeff", re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b"), is_aadhaar),
    Pattern("pan", "pan", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    Pattern("ifsc", "ifsc", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),
    Pattern("ssn", "ssn", re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")),
)

#: Placeholders the client is expected to emit. Ingress must never treat these as
#: leaks, and the planner must never let one come back out as a literal value.
REDACTION_MARKER = re.compile(r"^\[(?:REDACTED:[A-Z_]+|[A-Z_]+_\d+)\]$")
CONTAINS_MARKER = re.compile(r"\[(?:REDACTED:[A-Z_]+|[A-Z_]+_\d+)\]")


def find_raw_pii(text: str) -> list[Pattern]:
    """Patterns that match `text`. Returns the patterns, never the matched values."""
    hits: list[Pattern] = []
    for pattern in PATTERNS:
        for match in pattern.regex.finditer(text):
            if pattern.validate and not pattern.validate(match.group(0)):
                continue
            hits.append(pattern)
            break
    return hits
