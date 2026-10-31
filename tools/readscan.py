#!/usr/bin/env python3
"""readscan — what large whole-file reads cost in Claude Code sessions, and what the bulk-read
skill could take off. The Diagnose step for the `bulk-read-delegation` experiment
(app/hooks/bulk-read/, docs/optimization-agent.md "Skill in depth: bulk-read delegation").

    python3 tools/readscan.py [--days 30] [--threshold 350] [--answer-tokens 600] [--top 10]
                              [--json PATH|-] [--show-paths] [--root DIR]

Reads ~/.claude/projects (OPTHUB_PROJECTS or --root overrides), main threads and subagents. A
large read is a Read with no offset and no limit, or a plain `cat|less|more|nl|bat <file>`, whose
result has more lines than the threshold (the gate's default, 350). For each one:

  tokens    the result's characters / 4 — an estimate, and labelled as one
  carry     requests on the same thread after the read, until the next compaction or the end
  side      main thread or subagent (a subagent's read never reaches the main context)
  edited    the session edited that file afterwards: the agent needed the real text
  re-read   the session read the same file again afterwards

and prices it with tools/ratecard.py on the model of the next request on that thread:

  in context  tokens x input x (1-hour cache write + carry x cache-read multiplier)
  delegated   the worker's answer (--answer-tokens) carried the same way, plus the worker reading
              the file once, uncached, on claude-haiku-4-5

A read is delegable when it is on the main thread and the file was not edited afterwards. Every
dollar here is `priced` (tokens re-priced at list rates: a ceiling, at the 1-hour write); nothing
is measured. A real saving comes from running the experiment (`opt optimize` with
bulk-read-delegation), which also pays the worker's latency.

Privacy: prints counts and dollars. Files appear as a short hash unless --show-paths; session ids
are cut to 8 characters. --json writes the same; keep files from live sessions under data/private/.
"""
import argparse, collections, datetime as dt, glob, hashlib, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import onboardlib as ob  # noqa: E402
import ratecard  # noqa: E402

SHELL_READ = re.compile(r"^\s*(cat|less|more|nl|bat)\s+(.+)$")
SHELL_META = re.compile(r"[|;&<>`$()]")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
WORKER = "claude-haiku-4-5"


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _lines(text):
    return text.count("\n") + (1 if text and not text.endswith("\n") else 0)


def shell_targets(command, cwd):
    """Files a plain shell read names, resolved against cwd; [] when it is not one (gate.mjs's rule)."""
    m = SHELL_READ.match(str(command or ""))
    if not m or SHELL_META.search(m.group(2)):
        return []
    return [os.path.normpath(os.path.join(cwd or "", a.strip("'\""))) for a in m.group(2).split() if a and not a.startswith("-")]


def scan_thread(path, threshold):
    """One transcript file -> requests [(t, model)], compactions [t], large reads, edits, all reads."""
    reqs, boundaries, pending = {}, [], {}
    reads, edits, allreads = [], [], []
    with open(path, errors="replace") as fh:
        rows = [line for line in fh if line.startswith("{")]
    for line in rows:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        t = ob._ts(r.get("timestamp"))
        if (r.get("type") == "system" and r.get("subtype") == "compact_boundary") or r.get("isCompactSummary"):
            if t:
                boundaries.append(t)
            continue
        m = r.get("message") if isinstance(r.get("message"), dict) else {}
        if r.get("type") == "assistant":
            if t and isinstance(m.get("usage"), dict) and m.get("model") not in (None, "<synthetic>"):
                reqs.setdefault(ratecard.request_key(r), (t, m["model"]))
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                name, inp = b.get("name"), b.get("input") or {}
                if name == "Read" and inp.get("file_path"):
                    f = os.path.normpath(inp["file_path"])
                    allreads.append((t, f))
                    if inp.get("offset") is None and inp.get("limit") is None:
                        pending[b.get("id")] = ("Read", [f])
                elif name == "Bash":
                    fs_ = shell_targets(inp.get("command"), r.get("cwd"))
                    if fs_:
                        pending[b.get("id")] = ("Bash", fs_)
                        allreads.extend((t, f) for f in fs_)
                elif name in EDIT_TOOLS:
                    f = inp.get("file_path") or inp.get("notebook_path")
                    if f:
                        edits.append((t, os.path.normpath(f)))
        elif r.get("type") == "user" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if not isinstance(b, dict) or b.get("type") != "tool_result":
                    continue
                p = pending.pop(b.get("tool_use_id"), None)
                if not p or t is None:
                    continue
                text = _text(b.get("content"))
                tur = r.get("toolUseResult") if isinstance(r.get("toolUseResult"), dict) else {}
                n = (tur.get("file") or {}).get("numLines") if p[0] == "Read" else None
                nlines = n if isinstance(n, int) else _lines(text)
                if nlines > threshold:
                    reads.append(dict(t=t, tool=p[0], files=p[1], lines=nlines, chars=len(text)))
    return sorted(reqs.values()), sorted(boundaries), reads, edits, allreads


def price_in_context(tokens, model, carry):
    inp, _, rd = ratecard.rates(model) or ratecard.rates(ratecard.DEFAULT_MODEL)
    return tokens * inp * (ratecard.W1H + carry * rd) / 1e6


def worker_cost(tokens, answer):
    inp, out, _ = ratecard.rates(WORKER)
    return (tokens * inp + answer * out) / 1e6


def scan(root, since, threshold, answer_tokens):
    """Every large read in the window, as one row each, sorted by session and time."""
    rows = []
    for f in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
        sid = os.path.basename(f)[:-6]
        threads = [(f, "main")] + [(g, "sub") for g in sorted(glob.glob(os.path.join(f[:-6], "subagents", "*.jsonl")))]
        scanned = [(side,) + scan_thread(g, threshold) for g, side in threads]
        edits = [e for s in scanned for e in s[4]]
        allreads = [x for s in scanned for x in s[5]]
        for side, reqs, bounds, reads, _, _ in scanned:
            for rd in reads:
                if since and rd["t"] < since:
                    continue
                nb = next((b for b in bounds if b > rd["t"]), None)
                carry = sum(1 for tq, _ in reqs if tq > rd["t"] and (nb is None or tq < nb))
                model = next((mq for tq, mq in reqs if tq > rd["t"]), reqs[-1][1] if reqs else ratecard.DEFAULT_MODEL)
                edited = any(te and te > rd["t"] and fe in rd["files"] for te, fe in edits)
                reread = any(tr and tr > rd["t"] and fr in rd["files"] for tr, fr in allreads)
                tokens = rd["chars"] // 4
                in_ctx = price_in_context(tokens, model, carry)
                delegated = price_in_context(answer_tokens, model, carry) + worker_cost(tokens, answer_tokens)
                rows.append(dict(session=sid, t=rd["t"], side=side, tool=rd["tool"], files=rd["files"], lines=rd["lines"],
                                 tokens=tokens, carry=carry, model=model, edited=edited, reread=reread,
                                 delegable=side == "main" and not edited,
                                 in_context_usd=in_ctx, delegated_usd=delegated, saving_usd=in_ctx - delegated))
    rows.sort(key=lambda x: (x["session"], x["t"]))
    return rows


def _fid(f, show):
    return f if show else "file-" + hashlib.sha256(f.encode()).hexdigest()[:8]


def summarize(rows, sessions, threshold, show_paths=False, top=10):
    spend = sum(s["cost"] for s in sessions)
    d = [x for x in rows if x["delegable"]]
    per = collections.defaultdict(lambda: dict(reads=0, saving_usd=0.0))
    for x in d:
        per[x["session"]]["reads"] += 1
        per[x["session"]]["saving_usd"] += x["saving_usd"]
    tops = sorted(per.items(), key=lambda kv: -kv[1]["saving_usd"])[:top]
    return dict(
        schema="opthub.readscan/1", threshold=threshold, sessions=len(sessions), spend_usd=round(spend, 4),
        large_reads=len(rows), in_sessions=len({x["session"] for x in rows}),
        main=sum(x["side"] == "main" for x in rows), sub=sum(x["side"] == "sub" for x in rows),
        edited=sum(x["edited"] for x in rows), reread=sum(x["reread"] for x in rows),
        delegable=len(d), mean_carry=round(sum(x["carry"] for x in d) / len(d), 1) if d else 0,
        in_context_usd=round(sum(x["in_context_usd"] for x in d), 4),
        delegated_usd=round(sum(x["delegated_usd"] for x in d), 4),
        saving_usd=round(sum(x["saving_usd"] for x in d), 4),
        saving_share=round(sum(x["saving_usd"] for x in d) / spend, 4) if spend else 0,
        label="priced", tokens="characters / 4",
        top=[dict(session=k[:8], reads=v["reads"], saving_usd=round(v["saving_usd"], 4)) for k, v in tops],
        reads=[dict(session=x["session"][:8], t=x["t"].isoformat(), side=x["side"], tool=x["tool"],
                    files=[_fid(f, show_paths) for f in x["files"]], lines=x["lines"], tokens=x["tokens"],
                    carry=x["carry"], model=x["model"], edited=x["edited"], reread=x["reread"],
                    delegable=x["delegable"], saving_usd=round(x["saving_usd"], 4)) for x in rows],
    )


def render(s, days):
    pct = f"{100 * s['saving_share']:.1f}% of spend" if s["spend_usd"] else "no spend in window"
    out = [f"readscan · last {days} days · {s['sessions']} sessions · ${s['spend_usd']:.2f} at list rates · "
           f"threshold {s['threshold']} lines",
           f"  large whole-file reads   {s['large_reads']:5d}  in {s['in_sessions']} sessions  "
           f"(main thread {s['main']}, subagents {s['sub']})",
           f"    edited afterwards      {s['edited']:5d}  not delegable: the agent needed the text",
           f"    read again afterwards  {s['reread']:5d}",
           f"  delegable                {s['delegable']:5d}  main thread, not edited afterwards"]
    if s["delegable"]:
        out += [f"    in context        ${s['in_context_usd']:9.4f}  cache write + {s['mean_carry']} later requests on average",
                f"    delegated         ${s['delegated_usd']:9.4f}  answer carried + worker on {WORKER}",
                f"    saving ceiling    ${s['saving_usd']:9.4f}  {pct}"]
        out.append("  top sessions by saving ceiling")
        out += [f"    {t['session']}  {t['reads']:3d} reads  ${t['saving_usd']:.4f}" for t in s["top"]]
    out.append("  labels: priced = tokens re-priced at list rates, a ceiling (1-hour cache write); "
               "tokens = characters / 4; latency not counted")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=ob.PROJECTS)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--threshold", type=int, default=350, help="lines; the gate's default")
    ap.add_argument("--answer-tokens", type=int, default=600, help="assumed size of the worker's answer")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--json", metavar="PATH", help="write the summary and every read as JSON ('-' for stdout)")
    ap.add_argument("--show-paths", action="store_true", help="print file paths instead of hashes")
    a = ap.parse_args(argv)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)
    sessions, _ = ob.load(a.root, since=since)
    rows = scan(a.root, since, a.threshold, a.answer_tokens)
    s = summarize(rows, sessions, a.threshold, a.show_paths, a.top)
    if a.json == "-":
        print(json.dumps(s, indent=2))
    else:
        print(render(s, a.days))
        if a.json:
            with open(a.json, "w") as fh:
                json.dump(s, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
