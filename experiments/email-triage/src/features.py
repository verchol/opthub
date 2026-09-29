"""Context features — the 'assist' half of the experiment.

Every field is computed locally from Gmail metadata Oleg already has. None of it is
message text. These are the signals a central gateway cannot see, and the hypothesis
is that they matter more than anything in the subject line.
"""

from collections import defaultdict
from datetime import datetime, timezone

BULK_HINTS = ("substack.com", "medium.com", "mail.", "newsletter", "email.", "noreply", "no-reply")


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def build_sender_index(raws: list[dict], my_addresses: set[str]) -> dict:
    """One pass over the corpus: what do I know about each sender?"""
    idx = defaultdict(lambda: {"inbound": 0, "i_replied": 0, "last_seen": None, "prior_labels": set()})
    for r in raws:
        dom = r.get("sender", "").split("@")[-1].strip(">").lower()
        e = idx[dom]
        if (r.get("sender") or "").lower() in my_addresses:
            continue
        e["inbound"] += 1
        d = _dt(r["date"])
        if e["last_seen"] is None or d > e["last_seen"]:
            e["last_seen"] = d
        for lab in r.get("labelIds", []):
            if lab.startswith("Label_"):
                e["prior_labels"].add(lab)
    # a reply is a sent message in a thread that had inbound mail
    threads_with_my_reply = {
        r["threadId"] for r in raws if (r.get("sender") or "").lower() in my_addresses
    }
    for r in raws:
        if r["threadId"] in threads_with_my_reply:
            dom = r.get("sender", "").split("@")[-1].strip(">").lower()
            if (r.get("sender") or "").lower() not in my_addresses:
                idx[dom]["i_replied"] += 1
    return idx


def features_for(raw: dict, idx: dict, my_addresses: set[str], now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    dom = raw.get("sender", "").split("@")[-1].strip(">").lower()
    e = idx.get(dom, {"inbound": 0, "i_replied": 0, "last_seen": None, "prior_labels": set()})
    to = [a.lower() for a in raw.get("toRecipients", [])]
    return {
        "msgs_from_sender": e["inbound"],
        "i_ever_replied_to_sender": e["i_replied"] > 0,
        "days_since_first_contact": (now - e["last_seen"]).days if e["last_seen"] else None,
        "addressed_directly": any(a in my_addresses for a in to) and len(to) <= 3,
        "thread_len": raw.get("thread_len", 1),
        "looks_bulk_by_domain": any(h in dom for h in BULK_HINTS),
        "sender_domain_seen_before": e["inbound"] > 1,
        "i_am_only_recipient": len(to) == 1,
    }
