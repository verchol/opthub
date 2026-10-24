"""Durations written the way people write them in config files: "1h30m", "2d 4h", "90"."""
import re
from decimal import Decimal, InvalidOperation

UNITS = {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1}
ORDER = "wdhms"
PART = re.compile(r"(\d+(?:\.\d+)?)([a-z])")


def parse_duration(text: str) -> int:
    """Return the duration in whole seconds. SPEC.md is the contract."""
    s = (text or "").strip().lower()
    if not s:
        raise ValueError("empty duration")
    if s.isdigit():
        return int(s)
    total, pos, last = Decimal(0), 0, -1
    while pos < len(s):
        while pos < len(s) and s[pos] == " ":
            pos += 1
        m = PART.match(s, pos)
        if not m or m.group(2) not in UNITS:
            raise ValueError(f"cannot read {text!r} at {s[pos:]!r}")
        rank = ORDER.index(m.group(2))
        if rank <= last:
            raise ValueError(f"units out of order or repeated in {text!r}")
        last = rank
        try:
            total += Decimal(m.group(1)) * UNITS[m.group(2)]
        except InvalidOperation:
            raise ValueError(f"bad number in {text!r}")
        pos = m.end()
    if total != total.to_integral_value():
        raise ValueError(f"{text!r} is not a whole number of seconds")
    return int(total)
