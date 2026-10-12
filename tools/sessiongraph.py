#!/usr/bin/env python3
"""sessiongraph — one Claude Code session as a graph of tasks.

A task is one person's prompt and everything the agent did until the next one. Each
task links to the model(s) that ran it, the context it carried, the tools it called,
the files / commands / subagents those tools touched. Output is the JSON that
docs/preview/session-graph/ renders, so any session drops into the same view.

    python3 tools/sessiongraph.py 8f73f7f5                      # summary, newest match in ~/.claude/projects
    python3 tools/sessiongraph.py path/to/session.jsonl -o g.json
    python3 tools/sessiongraph.py 8f73f7f5 --html data/private/g.html --page triage
    python3 tools/sessiongraph.py 8f73f7f5 --keep-text -o data/private/g.json

STRIPPED BY DEFAULT. No prompt text, no tool inputs, no absolute paths: files become
paths relative to the session's cwd (or a bare basename), shell commands become their
family (`git diff`, `npm test`), web and MCP calls keep only the tool name.
--keep-text adds prompt titles and command lines, and then refuses to write anywhere
but data/private/ (gitignored).

Counting. A transcript writes one record per content block, all carrying the same
message id and the same usage, so requests are de-duplicated by message id. Subagent
transcripts (<session>/subagents/**/*.jsonl) are read too and charged to the task that
was running when they started. Cost is tools/sessions.py's req_cost (list-price
equivalent, `priced`), not a bill. Context per task is the largest single request's
input (fresh + cache read + cache write). Cache hit is a detector, not a lever.
"""
import argparse, collections, datetime as dt, glob, json, os, pathlib, re, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sessions import req_cost, DEFAULT_MODEL                       # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[1]
PREVIEW = REPO / "docs" / "preview" / "session-graph"
NOISE = ("<bash-", "<command-", "<local-command", "<task-notification", "<system-reminder",
         "Caveat:", "[Request interrupted", "<user-prompt-submit-hook")
FILE_TOOLS = {"Read": "read", "Edit": "write", "MultiEdit": "write", "Write": "write",
              "NotebookEdit": "write", "Update": "write"}
SEARCH_TOOLS = {"Grep", "Glob", "LS"}
AGENT_TOOLS = {"Agent", "Task", "Workflow"}
SECRET = re.compile(r"(sk-[\w-]{8,}|gh[pousr]_\w{8,}|AKIA[0-9A-Z]{12,}|eyJ[\w-]{20,}|[\w.+-]+@[\w-]+\.[\w.-]+"
                    r"|\b[A-Fa-f0-9]{32,}\b|\b[\w+/-]{40,}\b)")


def records(path):
    for line in open(path, errors="replace"):
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except ValueError:
                pass


def ts(r):
    t = r.get("timestamp")
    return dt.datetime.fromisoformat(t.replace("Z", "+00:00")) if t else None


def prompt_text(r):
    """The person's prompt on a user record, or None for tool results / meta / noise."""
    if r.get("type") != "user" or r.get("isMeta") or r.get("isSidechain"):
        return None
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(p, dict) and p.get("type") == "tool_result" for p in c):
            return None
        c = " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
    if not isinstance(c, str) or not c.strip() or c.lstrip().startswith(NOISE):
        return None
    return " ".join(c.split())


def cmd_family(cmd):
    """`cd x && FOO=1 git diff main | tail` -> `git diff`. Never more than two words."""
    for seg in re.split(r"&&|\|\||;|\||\n", cmd or ""):
        w = [x for x in seg.split() if "=" not in x or x.startswith("-")]
        if not w or w[0] in ("cd", "export", "set", "source", "."):
            continue
        head = os.path.basename(w[0])
        if len(w) > 1 and re.fullmatch(r"[a-z][a-z0-9:_-]*", w[1]):
            return f"{head} {w[1]}"
        return head
    return "shell"


def rel(path, cwd):
    if not path:
        return None
    if cwd and path.startswith(cwd.rstrip("/") + "/"):
        return path[len(cwd.rstrip("/")) + 1:]
    return path if not path.startswith(("/", "~")) else "…/" + os.path.basename(path.rstrip("/"))


def target(name, inp, cwd, keep):
    """(node id, kind, label, access, detail arg) for one tool call, or None."""
    if name in FILE_TOOLS:
        p = rel(inp.get("file_path") or inp.get("notebook_path"), cwd)
        return (p, "file", os.path.basename(p), FILE_TOOLS[name], p) if p else None
    if name in SEARCH_TOOLS:
        p = rel(inp.get("path"), cwd) or "."
        p = p.rstrip("/") + "/"
        return p, "dir", p, "search", p
    if name == "Bash":
        fam = cmd_family(inp.get("command", ""))
        arg = SECRET.sub("…", inp.get("command", ""))[:80] if keep else fam
        return "cmd:" + fam, "cmd", fam, "exec", arg
    if name in AGENT_TOOLS:
        return None                                    # subagents get their own node below
    if name in ("WebFetch", "WebSearch"):
        return "web", "web", "web", "fetch", "web"
    return None


def tool_label(name):
    if name.startswith("mcp__"):
        parts = name.split("__")
        return f"mcp:{parts[1]}" if len(parts) > 2 else name
    return name


def build(path, keep=False, max_res=36):
    path = pathlib.Path(path)
    sid = path.stem
    main = list(records(path))
    subs = sorted(glob.glob(str(path.with_suffix("") / "subagents" / "**" / "*.jsonl"), recursive=True))
    subs = [s for s in subs if not s.endswith("journal.jsonl")]
    cwd = next((r["cwd"] for r in main if r.get("cwd")), "")

    tasks, cur = [], None
    seen_req, results = set(), {}
    for r in main:
        for p in (r.get("message") or {}).get("content") or []:
            if isinstance(p, dict) and p.get("type") == "tool_result":
                c = p.get("content")
                n = len(c.splitlines()) if isinstance(c, str) else sum(len(x.get("text", "").splitlines()) for x in c or [] if isinstance(x, dict))
                results[p.get("tool_use_id")] = ("error" if p.get("is_error") else f"{n} line" + ("" if n == 1 else "s"))
    for r in main:
        t = ts(r)
        txt = prompt_text(r)
        if txt is not None:
            cur = dict(n=len(tasks) + 1, prompt=txt, start=t, end=t, reqs=0, cost=0.0, ctx=0, out=0,
                       models=collections.Counter(), calls=[], compacted=False,
                       sub=dict(n=0, reqs=0, cost=0.0, agents=set()), cache=[0, 0])
            tasks.append(cur)
            continue
        if cur is None:
            continue
        if t:
            cur["end"] = max(cur["end"] or t, t)
        if r.get("type") == "system" and r.get("subtype") == "compact_boundary" or r.get("type") == "summary":
            cur["compacted"] = True
        m = r.get("message") or {}
        if r.get("type") != "assistant":
            continue
        u, key = m.get("usage"), m.get("id") or r.get("requestId") or r.get("uuid")
        if u and key not in seen_req:
            seen_req.add(key)
            model = m.get("model") or DEFAULT_MODEL
            if model == "<synthetic>":
                continue
            cur["reqs"] += 1
            cur["models"][model] += 1
            cur["cost"] += req_cost(model, u)
            ctx = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            cur["ctx"] = max(cur["ctx"], ctx)
            cur["out"] += u.get("output_tokens", 0)
            cur["cache"][0] += u.get("cache_read_input_tokens", 0)
            cur["cache"][1] += ctx
        for p in m.get("content") or []:
            if isinstance(p, dict) and p.get("type") == "tool_use":
                cur["calls"].append(dict(name=p.get("name", "?"), input=p.get("input") or {}, id=p.get("id")))

    # subagents: charge each file to the task running at its first record
    for f in subs:
        recs = list(records(f))
        first = next((ts(r) for r in recs if ts(r)), None)
        owner = None
        for t in tasks:
            if first and t["start"] and t["start"] <= first:
                owner = t
        if owner is None:
            continue
        owner["sub"]["n"] += 1
        sk = set()
        for r in recs:
            m = r.get("message") or {}
            u, key = m.get("usage"), m.get("id") or r.get("uuid")
            if r.get("type") == "assistant" and u and key not in sk and m.get("model") != "<synthetic>":
                sk.add(key)
                model = m.get("model") or DEFAULT_MODEL
                owner["sub"]["reqs"] += 1
                owner["sub"]["cost"] += req_cost(model, u)
                owner["models"][model] += 0          # model is involved, requests counted under subagents
                owner["cache"][0] += u.get("cache_read_input_tokens", 0)
                owner["cache"][1] += u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)

    nodes, edges = {}, collections.defaultdict(lambda: dict(w=0, add=0, rm=0, kinds=set()))
    reads, touches = collections.defaultdict(list), collections.Counter()
    for t in tasks:
        tid = f"task:{t['n']}"
        detail, kinds, errors = [], collections.Counter(), 0
        for c in t["calls"]:
            name = c["name"]
            tool = "tool:" + tool_label(name)
            nodes.setdefault(tool, dict(kind="tool", label=tool_label(name)))
            e = edges[(tid, tool)]; e["w"] += 1; e["kinds"].add("calls")
            res = results.get(c["id"], "")
            errors += res == "error"
            tg = target(name, c["input"], cwd, keep)
            add = rm = 0
            if name in ("Edit", "Update", "MultiEdit"):
                pairs = c["input"].get("edits") or [c["input"]]
                add = sum(len((x.get("new_string") or "").splitlines()) for x in pairs)
                rm = sum(len((x.get("old_string") or "").splitlines()) for x in pairs)
            elif name == "Write":
                add = len((c["input"].get("content") or "").splitlines())
            if tg:
                rid, kind, label, acc, arg = tg
                nodes.setdefault(rid, dict(kind=kind, label=label, path=rid.replace("cmd:", "")))
                e = edges[(tid, rid)]; e["w"] += 1; e["kinds"].add(acc); e["add"] += add; e["rm"] += rm
                touches[rid] += 1
                kinds[acc] += 1
                if acc == "read":
                    reads[rid].append(t["n"])
            else:
                arg = ""
            detail.append(dict(tool=tool_label(name), arg=arg, add=add, rm=rm, result=res))
        if t["sub"]["n"]:
            aid = f"agent:{t['n']}"
            nodes[aid] = dict(kind="agent", label=f"{t['sub']['n']} subagent" + ("s" if t["sub"]["n"] > 1 else ""),
                              path=f"{t['sub']['n']} subagents · {t['sub']['reqs']} requests · ${t['sub']['cost']:.2f}")
            e = edges[(tid, aid)]; e["w"] = t["sub"]["n"]; e["kinds"].add("spawned")
            touches[aid] += 1
        klass = ("edit" if kinds["write"] else "run" if kinds["exec"] >= max(kinds["read"], kinds["search"], 1)
                 else "explore" if kinds["read"] or kinds["search"] else "chat")
        title = SECRET.sub("…", t["prompt"])[:80] if keep else f"{klass} · {len(t['calls'])} calls"
        secs = int((t["end"] - t["start"]).total_seconds()) if t["start"] and t["end"] else 0
        cost = t["cost"] + t["sub"]["cost"]
        nodes[tid] = dict(kind="task", label=title, n=t["n"], klass=klass, routes="unknown",
                          cost=round(cost, 4), tok_in=t["ctx"], tok_out=t["out"], secs=secs,
                          calls=len(t["calls"]), reqs=t["reqs"], sub=dict(t["sub"], agents=None),
                          detail=detail, errors=errors, compacted=t["compacted"])
        nodes[f"ctx:{t['n']}"] = dict(kind="context", label=f"{t['ctx']/1000:.1f}k in", tok=t["ctx"])
        edges[(tid, f"ctx:{t['n']}")]["kinds"].add("uses")
        for model, n in t["models"].items():
            mid = "model:" + model
            nodes.setdefault(mid, dict(kind="model", label=model))
            e = edges[(tid, mid)]; e["w"] += n; e["kinds"].add("ran on" if n else "subagents ran on")

    for t in tasks:
        n, sig = nodes[f"task:{t['n']}"], []
        re_read = sorted({nodes[r]["label"] for r, ns in reads.items() if t["n"] in ns and ns.index(t["n"]) > 0
                          and ns[0] < t["n"]})
        if re_read:
            sig.append(dict(k="re-read", v=", ".join(re_read[:4]) + (f" +{len(re_read)-4}" if len(re_read) > 4 else ""), label="detector"))
        if n["errors"]:
            sig.append(dict(k="tool errors", v=str(n["errors"]), label="measured", tone="blocked"))
        if n["compacted"]:
            sig.append(dict(k="compacted", v="context compacted in this task", label="measured", tone="policy"))
        if t["sub"]["n"]:
            sig.append(dict(k="subagents", v=f"{t['sub']['n']} · ${t['sub']['cost']:.2f}", label="priced", tone="policy"))
        n["signals"] = sig

    # cap the resource lane: keep the most-touched, say how many were dropped
    res_ids = [k for k, v in nodes.items() if v["kind"] in ("file", "dir", "cmd", "web", "agent")]
    keep_ids = {k for k, _ in touches.most_common(max_res)}
    dropped = [k for k in res_ids if k not in keep_ids]
    for k in dropped:
        del nodes[k]

    total_cache = [sum(t["cache"][0] for t in tasks), sum(t["cache"][1] for t in tasks)]
    models = collections.Counter()
    for t in tasks:
        models.update(t["models"])
    secs = int((tasks[-1]["end"] - tasks[0]["start"]).total_seconds()) if tasks and tasks[0]["start"] else 0
    return dict(
        meta=dict(kind="transcript", source=f"session {sid[:8]}" + (" · with text" if keep else " · stripped"),
                  session=sid[:8], title=f"{os.path.basename(cwd.rstrip('/')) or 'session'} · {len(tasks)} tasks",
                  duration=f"{secs // 3600}h{secs % 3600 // 60:02d}m" if secs >= 3600 else f"{secs // 60}m {secs % 60:02d}s",
                  model=models.most_common(1)[0][0] if models else DEFAULT_MODEL,
                  cache_hit=f"{100 * total_cache[0] / total_cache[1]:.1f}%" if total_cache[1] else "—",
                  tasks=len(tasks), cost=round(sum(nodes[f"task:{t['n']}"]["cost"] for t in tasks), 4),
                  tok_in=sum(t["ctx"] for t in tasks), tok_out=sum(t["out"] for t in tasks),
                  secs=sum(nodes[f"task:{t['n']}"]["secs"] for t in tasks),
                  calls=sum(len(t["calls"]) for t in tasks),
                  reqs=sum(t["reqs"] for t in tasks), sub_reqs=sum(t["sub"]["reqs"] for t in tasks),
                  subagents=sum(t["sub"]["n"] for t in tasks), dropped_res=len(dropped),
                  klass_source="activity, from the task's tool mix"),
        nodes=[dict(id=k, **v) for k, v in nodes.items()],
        edges=[dict(s=s, t=t, w=e["w"], add=e["add"], rm=e["rm"], kinds=sorted(e["kinds"]))
               for (s, t), e in edges.items() if s in nodes and t in nodes])


def find(arg, root):
    if os.path.exists(arg):
        return arg
    hits = [f for f in glob.glob(os.path.join(root, "*", "*.jsonl")) if os.path.basename(f).startswith(arg)]
    if not hits:
        sys.exit(f"no transcript matching {arg!r} under {root}")
    return max(hits, key=os.path.getmtime)


def private_only(out):
    priv = (REPO / "data" / "private").resolve()
    if priv not in pathlib.Path(out).resolve().parents:
        sys.exit(f"--keep-text output must go under {priv.relative_to(REPO)}/ (gitignored): {out}")


def page(graph, kind, out):
    tpl = (PREVIEW / f"{kind}-graph.template.html").read_text()
    pathlib.Path(out).write_text(tpl.replace("/*GRAPH*/null", json.dumps(graph).replace("</", "<\\/")))


def main():
    ap = argparse.ArgumentParser(description="One Claude Code session as a graph of tasks.")
    ap.add_argument("session", help="session id (prefix ok) or a .jsonl path")
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("-o", "--out", help="write graph JSON here")
    ap.add_argument("--html", help="write a self-contained page here")
    ap.add_argument("--page", choices=["triage", "session"], default="triage", help="which view --html renders")
    ap.add_argument("--keep-text", action="store_true", help="prompt titles + command lines; outputs must be under data/private/")
    ap.add_argument("--max-res", type=int, default=36, help="files/commands drawn (most-touched first)")
    a = ap.parse_args()

    g = build(find(a.session, a.root), keep=a.keep_text, max_res=a.max_res)
    for out in filter(None, (a.out, a.html)):
        if a.keep_text:
            private_only(out)
        pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(g, indent=1))
    if a.html:
        page(g, a.page, a.html)
    m = g["meta"]
    tools = collections.Counter()
    for e in g["edges"]:
        if e["t"].startswith("tool:"):
            tools[e["t"][5:]] += e["w"]
    print(f"{m['session']}  {m['tasks']} tasks · {m['reqs']} requests (+{m['sub_reqs']} in {m['subagents']} subagents) · "
          f"${m['cost']:.2f} priced · {m['calls']} tool calls · cache hit {m['cache_hit']} (detector)")
    print("  tools   " + "  ".join(f"{k} {v}" for k, v in tools.most_common(8)))
    print("  models  " + "  ".join(n["label"] for n in g["nodes"] if n["kind"] == "model"))
    if m["dropped_res"]:
        print(f"  {m['dropped_res']} less-touched files/commands not drawn (--max-res {a.max_res})")
    for out in filter(None, (a.out, a.html)):
        print(f"  -> {out}")


if __name__ == "__main__":
    main()
