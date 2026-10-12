#!/usr/bin/env python3
"""build — render the session-graph previews from the scripted demo session.

Parses docs/demo-mock-spec.md §5 (the ① MAIN block of each beat: tool calls, +/- line
counts, results, and the `── N tok in · M out · $X · Ns` footer; the beats table for
class and routing) into one graph — tasks, models, context, tools, files/commands — and
embeds it into both pages. Every number on the pages comes from that file; nothing is
typed by hand. Preview only: the real-transcript parser is tools/sessiongraph.py.

    python3 docs/preview/session-graph/build.py

Writes session-graph.html (the graph on its own) and triage-graph.html (the same graph
as a Graph tab on a Hub → Triage session page) next to this script.
"""
import json, re, collections, pathlib

HERE = pathlib.Path(__file__).resolve().parent
SPEC = HERE.parents[2] / "docs" / "demo-mock-spec.md"
txt = SPEC.read_text()
s5 = txt[txt.index("## 5. The scripted session"):txt.index("## 6.")]

# beats table: | 1 | idempotency keys | `coding/edit` | no | ... |
cls = {}
for m in re.finditer(r"^\| (\d) \| (.+?) \| `([^`]+)` \| \**([a-z]+)\** \|", s5, re.M):
    cls[int(m[1])] = dict(title=m[2], klass=m[3], routes=m[4])

model = re.search(r"· \d+ turns · (claude-[\w-]+)", s5)[1]
alt = re.search(r"cheapest allowed: (claude-[\w-]+)", s5)[1]
sess = re.search(r"session report · (sess_\w+)", s5)[1]
dur = re.search(r"\n\s+(\d+m \d+s) · \d+ turns", s5)[1]
cache_hit = re.search(r"cache-priming\s+DETECTOR\s+hit rate ([\d.]+%)", s5)[1]

tasks = []
for m in re.finditer(r"^### Beat (\d) — (.+?)$(.*?)(?=^### Beat|\Z)", s5, re.M | re.S):
    n, body = int(m[1]), m[3]
    main = re.search(r"\*\*① MAIN\*\*.*?```\n(.*?)```", body, re.S)[1]
    calls, last = [], None
    for line in main.splitlines():
        t = re.match(r"⏺ (\w+)\((.*)\)\s*(\+\d+)?\s*(-\d+)?\s*$", line)
        if t:
            last = dict(tool=t[1], arg=t[2], add=int(t[3] or 0), rm=-int(t[4] or 0), result="")
            calls.append(last)
        elif last and line.strip().startswith("⎿"):
            last["result"] = line.strip()[1:].strip()
    f = re.search(r"── ([\d,]+) tok in · ([\d,]+) out · \$([\d.]+) · (\d+)s", main)
    tasks.append(dict(n=n, **cls[n], calls=calls, tok_in=int(f[1].replace(",", "")),
                      tok_out=int(f[2].replace(",", "")), cost=float(f[3]), secs=int(f[4])))

def target(c):
    """resource node a call touches: (id, kind, label, access)"""
    tool, arg = c["tool"], c["arg"]
    if tool in ("Read", "Update", "Write"):
        return arg, "file", arg.split("/")[-1], "read" if tool == "Read" else "write"
    if tool == "Grep":
        p = re.search(r'path: "([^"]+)"', arg)[1]
        return p + "/", "dir", p + "/", "search"
    words = arg.split()
    fam = " ".join(words[:2]) if words[0] in ("npm", "gh", "git") else words[0]
    fam = {"npm test": "npm test", "npm run": "npm run test:e2e"}.get(fam, fam)
    return "cmd:" + fam, "cmd", fam, "exec"

nodes, edges = {}, collections.defaultdict(lambda: dict(w=0, add=0, rm=0, kinds=set()))
nodes["model:" + model] = dict(kind="model", label=model)
nodes["model:" + alt] = dict(kind="model", label=alt, alt=True)
reads = collections.defaultdict(list)
for t in tasks:
    tid = f"task:{t['n']}"
    t["calls_detail"] = [dict(tool=c["tool"], arg=c["arg"][:60], add=c["add"], rm=c["rm"], result=c["result"]) for c in t["calls"]]
    nodes[tid] = dict(kind="task", label=t["title"], n=t["n"], klass=t["klass"], routes=t["routes"],
                      cost=t["cost"], tok_in=t["tok_in"], tok_out=t["tok_out"], secs=t["secs"],
                      calls=len(t["calls"]), detail=t["calls_detail"])
    nodes[f"ctx:{t['n']}"] = dict(kind="context", label=f"{t['tok_in']/1000:.1f}k in", tok=t["tok_in"])
    edges[(tid, f"ctx:{t['n']}")]["kinds"].add("uses")
    edges[(tid, "model:" + model)]["kinds"].add("ran on")
    if t["routes"] == "yes":
        edges[(tid, "model:" + alt)]["kinds"].add("routable to")
    if t["routes"] == "blocked":
        edges[(tid, "model:" + alt)]["kinds"].add("blocked")
    for c in t["calls"]:
        tool = "tool:" + c["tool"]
        nodes.setdefault(tool, dict(kind="tool", label=c["tool"]))
        e = edges[(tid, tool)]; e["w"] += 1; e["kinds"].add("calls")
        rid, kind, label, acc = target(c)
        nodes.setdefault(rid, dict(kind=kind, label=label, path=rid.replace("cmd:", "")))
        e = edges[(tid, rid)]; e["w"] += 1; e["kinds"].add(acc); e["add"] += c["add"]; e["rm"] += c["rm"]
        if acc == "read":
            reads[rid].append(t["n"])

# derived signals
for t in tasks:
    sig = []
    re_read = [nodes[r]["label"] for r, ns in reads.items() if t["n"] in ns and ns.index(t["n"]) > 0]
    if re_read:
        sig.append(dict(k="re-read", v=", ".join(re_read), label="detector"))
    if t["routes"] == "yes":
        sig.append(dict(k="routable", v=f"non-coding → {alt}", label="policy"))
    if t["routes"] == "blocked":
        sig.append(dict(k="never-downgrade", v="review/security blocked by policy", label="policy"))
    nodes[f"task:{t['n']}"]["signals"] = sig

graph = dict(meta=dict(kind="mock", session=sess, duration=dur, title="incident fix in acme-api", source="docs/demo-mock-spec.md §5", model=model, cache_hit=cache_hit,
                       tasks=len(tasks), cost=round(sum(t["cost"] for t in tasks), 2),
                       tok_in=sum(t["tok_in"] for t in tasks), tok_out=sum(t["tok_out"] for t in tasks),
                       secs=sum(t["secs"] for t in tasks), calls=sum(len(t["calls"]) for t in tasks)),
             nodes=[dict(id=k, **v) for k, v in nodes.items()],
             edges=[dict(s=s, t=t, w=e["w"], add=e["add"], rm=e["rm"], kinds=sorted(e["kinds"]))
                    for (s, t), e in edges.items()])
for name in ("session-graph", "triage-graph"):
    tpl = (HERE / f"{name}.template.html").read_text()
    (HERE / f"{name}.html").write_text(tpl.replace("/*GRAPH*/null", json.dumps(graph).replace("</", "<\\/")))
m = graph["meta"]
print(f"{m['session']}: {m['tasks']} tasks · ${m['cost']:.2f} · {m['calls']} tool calls · "
      f"{len(graph['nodes'])} nodes · {len(graph['edges'])} edges -> {HERE.name}/{{session,triage}}-graph.html")
