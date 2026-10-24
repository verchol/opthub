# parse_duration(text) -> int

Returns a duration in whole seconds.

- Units: `w` (604800 s), `d` (86400), `h` (3600), `m` (60), `s` (1). Units are case-insensitive.
- A duration is one or more parts. A part is a number immediately followed by a unit: `1h30m`, `2d 4h`, `45s`.
- Parts appear in descending unit order, each unit at most once. `30m1h` and `1h1h` are errors.
- Spaces between parts are allowed. Leading and trailing whitespace is ignored.
- A bare integer with no unit is seconds: `90` is 90. It cannot be combined with other parts.
- A part's number may have one decimal point (`1.5h` is 5400) only if the result is a whole number of seconds.
  `0.5s` is an error.
- `0` and `0s` are valid and return 0.
- Everything else raises `ValueError`: empty or whitespace-only input, an unknown unit, a sign (`-5m`, `+5m`),
  a unit with no number (`h`), a trailing number without a unit after other parts (`1h30`), two decimal points.
