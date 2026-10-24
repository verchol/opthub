"""Interactive arm: the person who ran the sessions labels them at the terminal (README §8, gold).

Automatic arms (rules, Jev) answer every session; this one asks. For each session, most
expensive first, it prints the same evidence a classifier sees plus the rules answer, and
asks every axis in turn. Enter keeps the suggestion, a number or option prefix picks one,
`u` is unclear, `?` prints the option wording, `s` skips the session, `q` stops and keeps
what was labelled so far.

Labels are appended to a gold file (default data/private/gold.jsonl, gitignored) as each
session is finished, keyed by session id or ledger key, so a run can stop and resume. A
later automatic run loads the same file as the `human` arm without asking anything.
"""

import json
import pathlib
import sys

from .base import Verdict

U = "unclear"


def gold_key(s):
    return s.get("session_id") or s["key"]


def load_gold(path):
    out = {}
    p = pathlib.Path(path)
    if p.exists():
        for line in p.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                out[row["key"]] = row["labels"]
    return out


class HumanLabeller:
    name = "human"

    def __init__(self, taxonomy, gold_path, inp=input, out=sys.stdout):
        self.taxonomy = taxonomy
        self.gold_path = pathlib.Path(gold_path)
        self.gold = load_gold(gold_path)
        self.inp, self.out = inp, out

    def verdicts(self, sessions):
        """What the gold file says, as one Verdict per labelled session."""
        return {s["id"]: Verdict(labels=dict(self.gold[gold_key(s)]))
                for s in sessions if gold_key(s) in self.gold}

    def _say(self, *a):
        print(*a, file=self.out, flush=True)

    def _show(self, s, n, total):
        e, f = s["evidence"], s["features"] or {}
        self._say(f"\n── session {n}/{total} · {s['id']} · {e['entry_point']} · {e['project_kind']} · "
                  f"started {e['started_local']}")
        self._say(f"   {e['requests']} requests · context median {e['context_tokens_median']:,} / max "
                  f"{e['context_tokens_max']:,} · thinking {e['thinking_share_of_output']:.0%} of output")
        if f:
            g = f.get("reply_gap_median_s")
            self._say(f"   {f.get('human_prompts', '?')} prompts · reply gap median "
                      f"{'—' if g is None else f'{g:.0f}s'} · {f.get('topic_breaks', 0)} topic breaks · "
                      f"span {f.get('span_minutes', '?')} min · subagents {f.get('subagent_request_share', 0):.0%}")
            flags = [k.replace("mentions_", "") for k, v in (f.get("prompt_flags") or {}).items() if v]
            if flags:
                self._say("   prompts mention: " + ", ".join(flags))

    def _ask(self, axis, spec, suggestion):
        opts = list(spec["options"])
        menu = "  ".join(f"{i + 1}={o}" for i, o in enumerate(opts))
        while True:
            ans = self.inp(f"  {axis}: {spec['question']}\n    {menu}  [Enter={suggestion}] > ").strip().lower()
            if not ans:
                return suggestion
            if ans in ("s", "q"):
                return ans
            if ans == "?":
                for o, text in spec["options"].items():
                    self._say(f"    {o}: {text}")
                continue
            if ans == "u":
                return U
            if ans.isdigit() and 1 <= int(ans) <= len(opts):
                return opts[int(ans) - 1]
            hits = [o for o in opts if o.startswith(ans)]
            if len(hits) == 1:
                return hits[0]
            self._say("    ? — a number, an option prefix, u, s (skip session), q (stop), ? (wording)")

    def run(self, sessions, suggestions, limit):
        """Ask about up to `limit` unlabelled sessions, most expensive first."""
        todo = [s for s in sorted(sessions, key=lambda s: -s["ledger"]["cost"]) if gold_key(s) not in self.gold]
        todo = todo[:limit]
        self._say(f"interactive labelling: {len(self.gold)} sessions already in {self.gold_path.name}, "
                  f"{len(todo)} to go. Enter keeps the suggestion; s skips; q stops.")
        self.gold_path.parent.mkdir(parents=True, exist_ok=True)
        for n, s in enumerate(todo, 1):
            self._show(s, n, len(todo))
            sug = suggestions.get(s["id"]) or {}
            labels = {}
            for axis, spec in self.taxonomy["axes"].items():
                a = self._ask(axis, spec, sug.get(axis, U))
                if a in ("s", "q"):
                    break
                labels[axis] = a
            else:
                self.gold[gold_key(s)] = labels
                with self.gold_path.open("a") as fh:
                    fh.write(json.dumps({"key": gold_key(s), "labels": labels}) + "\n")
                continue
            if a == "q":
                break
        self._say(f"{len(self.gold)} sessions labelled in {self.gold_path}")
        return self.verdicts(sessions)
