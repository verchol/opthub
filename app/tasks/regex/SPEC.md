# Task: `rex.py` — a backtracking regular-expression engine

Implement a single module `rex.py` in the repository root. Pure Python 3
standard library only. **You may not import `re`, `regex`, or any other regular
expression library** — implement the engine yourself. No network.

## Public API

```python
class RegexError(Exception): ...

def compile(pattern: str) -> Pattern: ...

class Pattern:
    def search(self, text: str) -> Match | None: ...
    def match(self, text: str) -> Match | None: ...
    def findall(self, text: str) -> list[str]: ...

class Match:
    def group(self, n: int = 0) -> str | None: ...
    def start(self, n: int = 0) -> int: ...
    def end(self, n: int = 0) -> int: ...
    def groups(self) -> tuple[str | None, ...]: ...
```

* `search` finds the **leftmost** match anywhere in `text`.
* `match` succeeds only if the match begins at position 0.
* `findall` returns every non-overlapping match of group 0, scanning left to
  right. After a non-empty match, scanning resumes at its end; after an **empty**
  match, scanning resumes one character later (so `findall` always terminates).
* `group(0)` is the whole match. `group(n)` is capture group *n*, counting `(`
  from 1, left to right by opening parenthesis. A group that did not participate
  returns `None`, and its `start`/`end` are `-1`.
* `groups()` returns all capture groups in order, excluding group 0.
* An out-of-range group number raises `IndexError`.

## Syntax

| construct | meaning |
|---|---|
| `abc` | literal characters |
| `.` | any character **except** `\n` |
| `[abc]` `[a-z0-9]` | character class; `-` is literal first or last |
| `[^abc]` | negated class |
| `*` `+` `?` | greedy repetition of the preceding item |
| `*?` `+?` `??` | lazy repetition |
| `{m}` `{m,}` `{m,n}` | counted repetition, greedy; `{m,n}?` lazy |
| `(...)` | capturing group |
| `(?:...)` | non-capturing group |
| `a\|b` | alternation, lowest precedence |
| `^` `$` | start / end of the whole text |
| `\d \D \w \W \s \S` | digit / word / whitespace classes and negations |
| `\n \t \r` | newline, tab, carriage return |
| `\.` `\*` `\\` `\[` … | escape any non-alphanumeric character to make it literal |

Escapes work inside classes too: `[\d.]`, `[^\s]`.

## Semantics

**Backtracking, leftmost-first.** Alternation prefers its left branch. Greedy
quantifiers take as much as possible then give characters back on failure; lazy
quantifiers take as little as possible then take more. This is exactly the
behaviour of Perl-style engines — `(a|ab)c` matching `"abc"` must succeed by
backtracking to the second alternative.

Repetition applies to the single preceding item: a literal, a class, a `.`, an
escape, or a group. `a{2,3}` repeats `a`; `(ab)+` repeats the group. When a
group repeats, its capture holds the **last** iteration that matched.

`^` matches only at position 0 and `$` only at the very end of the text (no
multiline mode).

## Errors

`compile` raises `RegexError` for a malformed pattern: unbalanced `(` or `)`,
an unterminated `[`, a quantifier with nothing to repeat (`*ab`, `a|*`), a
malformed `{m,n}` such as `a{2,1}` or `a{}`, or a trailing backslash.

A `{` that is not part of a well-formed counted repetition is a **literal** `{` —
`a{b`, `a{}` and `a{2,x` all match those characters literally.

## Done means

`python3 -m unittest discover -s tests -v` passes, and the module imports
cleanly with no side effects at import time.
