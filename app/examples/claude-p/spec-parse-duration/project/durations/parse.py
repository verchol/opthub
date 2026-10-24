"""Durations written the way people write them in config files: "1h30m", "2d 4h", "90"."""


def parse_duration(text: str) -> int:
    """Return the duration in whole seconds. SPEC.md is the contract."""
    raise NotImplementedError
