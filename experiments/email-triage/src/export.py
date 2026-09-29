#!/usr/bin/env python3
"""Host-side export: Gmail -> data/private/corpus.local.jsonl

Runs on the host because it needs mail credentials, which never enter the sandbox.
Writes into data/private/, which is gitignored: this repository is public.

Two ways to fill it:
  1. Paste JSON from the Gmail MCP search_threads tool into data/private/raw.json
     and run this with --from-json.
  2. Point it at the Gmail API with your own OAuth token (--from-api), if you have
     one set up. Not required for the experiment.

The output keeps only the fields the experiment uses. Bodies are never exported;
the snippet is enough and bounds the exposure.
"""

import argparse
import json
import pathlib

FIELDS = ("id", "threadId", "date", "sender", "subject", "snippet", "toRecipients", "labelIds")
OUT = pathlib.Path(__file__).resolve().parents[1] / "data" / "private" / "corpus.local.jsonl"


def flatten(threads: list[dict]) -> list[dict]:
    rows = []
    for t in threads:
        msgs = t.get("messages", [])
        for m in msgs:
            row = {k: m.get(k) for k in FIELDS}
            row["thread_len"] = len(msgs)
            rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", default=str(OUT.parent / "raw.json"),
                    help="a file holding {'threads': [...]} as returned by search_threads")
    a = ap.parse_args()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(pathlib.Path(a.from_json).read_text())
    rows = flatten(data.get("threads", data if isinstance(data, list) else []))
    with OUT.open("w") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{len(rows)} messages -> {OUT}")
    print("gold labels are NOT set. Add a 'gold' object per row, or run label_assist.py.")


if __name__ == "__main__":
    main()
