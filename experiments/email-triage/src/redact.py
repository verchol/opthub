"""Redact an email record before it leaves the machine.

This is not a redaction service. Body text can still contain private data that no
pattern matches. The point is to remove the mechanically-findable identifiers and to
bound how much text ever goes to a third party, so the residual risk is a decision
Oleg makes per lane rather than an accident.
"""

import re

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s().]{7,}\d)(?!\d)")
URL = re.compile(r"https?://\S+")
MONEY = re.compile(r"(?:[$€£₪]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|ILS|NIS))")
LONGNUM = re.compile(r"(?<!\d)\d{6,}(?!\d)")
CODE = re.compile(r"\b(?:[A-Z0-9]{6,}|[a-f0-9]{16,})\b")

MAX_SNIPPET_CHARS = 400


def redact_text(text: str) -> str:
    if not text:
        return ""
    t = URL.sub("<url>", text)
    t = EMAIL.sub("<email>", t)
    t = PHONE.sub("<phone>", t)
    t = MONEY.sub("<amount>", t)
    t = CODE.sub("<code>", t)
    t = LONGNUM.sub("<num>", t)
    t = re.sub(r"[͏​‌‍­﻿]+", "", t)  # substack padding
    t = re.sub(r"\s+", " ", t).strip()
    return t[:MAX_SNIPPET_CHARS]


LOCAL_CLASSES = {
    "noreply": ("noreply", "no-reply", "donotreply", "notifications", "updates"),
    "billing": ("invoice", "billing", "receipt", "statements", "payments"),
    "security": ("security", "account", "auth", "alerts"),
    "marketing": ("newsletter", "marketing", "news", "hello", "hey", "team", "info", "subscriptions"),
}


def sender_local_class(sender: str) -> str:
    """The local part carries real signal but is also identifying.

    Keep the signal, drop the identity: report which family the local part belongs to,
    never the string itself. A human-looking local part becomes 'person', not the name.
    """
    m = EMAIL.search(sender or "")
    if not m:
        return "unknown"
    local = m.group(0).split("@", 1)[0].lower()
    base = local.split("+", 1)[0]
    for cls, hints in LOCAL_CLASSES.items():
        if any(h in base for h in hints):
            return cls
    return "person" if re.fullmatch(r"[a-z]+([._-][a-z]+)?", base) else "other"


def sender_domain(sender: str) -> str:
    m = EMAIL.search(sender or "")
    return m.group(0).split("@", 1)[1].lower() if m else "unknown"


def redact_record(raw: dict) -> dict:
    """raw -> the only thing an external classifier is ever shown."""
    return {
        "id": raw["id"],
        "sender_domain": sender_domain(raw.get("sender", "")),
        "sender_local_class": sender_local_class(raw.get("sender", "")),
        "sender_is_self": "canarian.io" in (raw.get("sender") or "").lower(),
        "subject": redact_text(raw.get("subject", "")),
        "snippet": redact_text(raw.get("snippet", "")),
        "lang": "he" if re.search(r"[֐-׿]", raw.get("subject", "") + raw.get("snippet", "")) else "other",
    }
