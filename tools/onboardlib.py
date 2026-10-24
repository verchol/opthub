"""onboardlib — what the onboarding probes share (docs/onboarding-spec.md).

One transcript loader (usage counted once per request, subagents included), the
`opthub.finding/1` record, the silence floor and the stability rule. No text leaves this
module: a loaded session carries numbers, model ids, tool names and a hashed project id,
never prompts, tool inputs or paths.
"""
import collections, datetime as dt, glob, hashlib, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ratecard  # noqa: E402

SCHEMA = "opthub.finding/1"
FLOOR_PCT, FLOOR_USD = 0.01, 1.0        # silent under max(1% of window spend, $1)
K = 5                                   # stability sub-windows (SPEC §6.5)
PROJECTS = os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects")


def _ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def _agent_type(f):
    try:
        with open(f[:-len(".jsonl")] + ".meta.json") as fh:
            return json.load(fh).get("agentType") or "subagent"
    except (OSError, ValueError):
        return "subagent"


def load(root=PROJECTS, since=None, until=None, only=None):
    """Sessions with at least one billed request, oldest first. Each request:
    t, model, u (usage), side ('main' | 'sub'), agent, stop, tools (names called), effort, skill.
    A session's project_dir is the transcript folder name (a path): local use only, never output.
    Also returns the counting check: (usage records read, distinct requests). only: session ids."""
    S, by_key, raw = {}, {}, 0
    for f in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
        sid = os.path.basename(f)[:-6]
        if only and sid not in only:
            continue
        proj = hashlib.sha256(os.path.basename(os.path.dirname(f)).encode()).hexdigest()[:12]
        files = [(f, None)] + [(g, _agent_type(g)) for g in sorted(glob.glob(os.path.join(f[:-6], "subagents", "*.jsonl")))]
        for g, agent in files:
            with open(g, errors="replace") as fh:
                rows = [line for line in fh if line.startswith("{")]
            for line in rows:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("type") != "assistant" or not isinstance(r.get("message"), dict):
                    continue
                m, t = r["message"], _ts(r.get("timestamp"))
                u = m.get("usage")
                if not isinstance(u, dict) or m.get("model") in (None, "<synthetic>") or t is None:
                    continue
                if (since and t < since) or (until and t >= until):
                    continue
                raw += 1
                key = ratecard.request_key(r)
                q = by_key.get(key)
                if q is None:
                    side = "sub" if agent or r.get("isSidechain") else "main"
                    q = by_key[key] = dict(t=t, model=m["model"], u=u, side=side,
                                           agent=agent or ("sidechain" if side == "sub" else None),
                                           stop=m.get("stop_reason"), tools=[],
                                           effort=r.get("effort"), skill=r.get("attributionSkill"))
                    s = S.setdefault(sid, dict(sid=sid, project=proj, project_dir=os.path.basename(os.path.dirname(f)),
                                               entry=r.get("entrypoint") or "", reqs=[], subs=[]))
                    (s["reqs"] if side == "main" else s["subs"]).append(q)
                    s["entry"] = s["entry"] or r.get("entrypoint") or ""
                q["stop"] = q["stop"] or m.get("stop_reason")
                for b in m.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        q["tools"].append(b.get("name"))
    out = []
    for s in S.values():
        s["reqs"].sort(key=lambda q: q["t"])
        s["subs"].sort(key=lambda q: q["t"])
        allq = s["reqs"] + s["subs"]
        s["start"], s["end"] = min(q["t"] for q in allq), max(q["t"] for q in allq)
        s["cost"] = sum(cost(q) for q in allq)
        out.append(s)
    out.sort(key=lambda s: (s["start"], s["sid"]))
    return out, dict(records=raw, requests=len(by_key))


def cost(q, model=None):
    return ratecard.req_cost(model or q["model"], q["u"])


def ctx(q):
    return ratecard.prompt_tokens(q["u"])


def input_hash(sessions):
    """sha256 of the trace set: every request's key fields and usage, in a fixed order."""
    h = hashlib.sha256()
    for s in sessions:
        for q in s["reqs"] + s["subs"]:
            h.update(json.dumps([s["sid"], q["t"].isoformat(), q["model"], q["side"], q["u"]],
                                sort_keys=True, default=str).encode())
    return "sha256:" + h.hexdigest()


def window(sessions):
    if not sessions:
        return dict(start=None, end=None, days=0, input_hash=input_hash([]))
    a, b = min(s["start"] for s in sessions), max(s["end"] for s in sessions)
    return dict(start=a.isoformat(timespec="seconds"), end=b.isoformat(timespec="seconds"),
                days=round((b - a).total_seconds() / 86400, 2), input_hash=input_hash(sessions))


def floor(window_usd):
    return max(FLOOR_PCT * window_usd, FLOOR_USD)


def subwindows(sessions, k=K):
    """k disjoint groups of sessions, contiguous by start time, near-equal in count."""
    n = len(sessions)
    return [sessions[i * n // k:(i + 1) * n // k] for i in range(k)] if n >= k else []


def sign_flips(deltas, total):
    """Sub-windows whose delta points the other way from the total. Zero deltas don't count."""
    sg = (total > 0) - (total < 0)
    return sum(1 for d in deltas if d and ((d > 0) - (d < 0)) != sg)


def finding(probe, lever, tier, predicate, sessions, spend, win, current, policy, cf, label,
            status, nxt, window_usd, stability=None, depends_on=(), note=None):
    """One opthub.finding/1 record. delta = current - counterfactual (positive saves)."""
    d = current - cf
    f = collections.OrderedDict(
        schema=SCHEMA, probe=probe, lever=lever, tier=tier,
        population=dict(predicate=predicate, sessions=sessions, spend_usd=round(spend, 4)),
        window=win, ratecard=ratecard.VERSION, current_usd=round(current, 4),
        counterfactual=dict(policy=policy, usd=round(cf, 4)),
        delta=dict(usd=round(d, 4), pct_of_window=round(100 * d / window_usd, 3) if window_usd else 0.0),
        label=label, stability=stability or dict(k=K, sign_flips=None),
        depends_on=list(depends_on), status=status, next=nxt)
    if note:
        f["note"] = note
    return f


def dumps(f):
    return json.dumps(f, separators=(",", ":"), default=str)
