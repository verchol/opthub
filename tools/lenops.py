#!/usr/bin/env python3
"""
lenops — session ops report for Claude Code transcripts.

Reads the transcript from disk: costs nothing, and does not perturb what it
measures. Shares its cost model with tools/loopscan.py and tools/savings.py.
Read the LEVERS note before quoting any lever — only C is measured.

  python3 tools/lenops.py view              # current session (default)
  python3 tools/lenops.py view --all        # every session in this project
  python3 tools/lenops.py view --session <uuid>
"""
import argparse, glob, json, os, sys, datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratecard import DEFAULT_MODEL, W1H, W5, parts, rates, req_cost, request_key, split_write  # noqa: E402

WINDOW = 1_000_000
SONNET = "claude-sonnet-5"
TRIM, EFFORT = 0.25, 0.50           # lever A and B assumptions — INVENTED, see E1

C = {"d":"\033[2m","r":"\033[31m","g":"\033[32m","y":"\033[33m",
     "c":"\033[36m","b":"\033[1m","o":"\033[0m"}
TTY = sys.stdout.isatty()
def c(s,k): return f"{C[k]}{s}{C['o']}" if TTY else str(s)
def hd(t): print("\n" + c(t,"b"))
def kv(k,v,note="",w=13): print(f"  {c(k.ljust(w),'d')}{v}" + (f"  {c(note,'d')}" if note else ""))
def pct(x,t): return f"{100*x/t:5.1f}%" if t else "    —"
def hms(ms):
    s = ms/1000
    return f"{s:.0f}s" if s < 90 else f"{s/60:.1f}m"

def load(path):
    reqs, turns, seen = [], [], set()
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try: r = json.loads(line)
            except Exception: continue
            if r.get("subtype") == "turn_duration" and r.get("durationMs"):
                turns.append(r["durationMs"])
            m = r.get("message") or {}
            if not isinstance(m, dict): continue
            u = m.get("usage")
            if not isinstance(u, dict): continue
            ctx = (u.get("input_tokens",0) + u.get("cache_read_input_tokens",0)
                   + u.get("cache_creation_input_tokens",0))
            if not ctx: continue
            model = m.get("model") or DEFAULT_MODEL
            if model == "<synthetic>" or request_key(r) in seen: continue
            seen.add(request_key(r))
            try: t = dt.datetime.fromisoformat(r["timestamp"].replace("Z","+00:00"))
            except Exception: t = None
            reqs.append({"t":t, "ctx":ctx, "u":u, "model":model,
                         "miss":(m.get("diagnostics") or {}).get("cache_miss_reason")})
    return reqs, turns

def view(path, reqs, turns):
    if not reqs:
        print(f"no billable requests in {os.path.basename(path)}"); return

    cr=i_=out=think=w1=w5=0; think_usd=0.0
    money={"read":0.0,"write":0.0,"out":0.0,"in":0.0}
    sonnet=0.0; models={}; tiers=set()
    for r in reqs:
        u,m = r["u"], r["model"]
        q = (rates(m) or rates(DEFAULT_MODEL))[1]
        b,a = split_write(u)
        R=u.get("cache_read_input_tokens",0); I=u.get("input_tokens",0); O=u.get("output_tokens",0)
        TH=(u.get("output_tokens_details") or {}).get("thinking_tokens",0) or 0
        cr+=R; i_+=I; out+=O; think+=TH; w1+=a; w5+=b; think_usd+=TH*q/1e6
        pt = parts(m, u); cost = sum(pt.values())
        money["read"]+=pt["read"]; money["write"]+=pt["write"]
        money["out"]+=pt["output"]; money["in"]+=pt["input"]
        sonnet += req_cost(SONNET, u)
        d = models.setdefault(m, {"n":0,"$":0.0,"ctx":0})
        d["n"]+=1; d["$"]+=cost; d["ctx"]+=r["ctx"]
        if u.get("speed"): tiers.add(u["speed"])
    total=sum(money.values()); n=len(reqs)
    ctxs=[r["ctx"] for r in reqs]; cur,peak,floor = ctxs[-1], max(ctxs), min(ctxs)
    ts=[r["t"] for r in reqs if r["t"]]
    gaps=sorted((ts[k]-ts[k-1]).total_seconds() for k in range(1,len(ts))) if len(ts)>1 else []
    span=(ts[-1]-ts[0]).total_seconds() if len(ts)>1 else 0

    # TTL counterfactual — same semantics as loopscan.ttl_counterfactual
    act=cf=0.0; forced=forced_tok=0; prev=None
    for r in reqs:
        p,_,rd=rates(r["model"]) or rates(DEFAULT_MODEL)
        b,a=split_write(r["u"]); cw=a+b; R=r["u"].get("cache_read_input_tokens",0)
        act += (cw*p*W1H + R*p*rd)/1e6
        gap=(r["t"]-prev).total_seconds() if (prev and r["t"]) else 1e9
        if gap>300 and R>0: cf += (cw+R)*p*W5/1e6; forced+=1; forced_tok+=R
        else: cf += (cw*p*W5 + R*p*rd)/1e6
        prev = r["t"] or prev
    delta = act-cf

    p_now,_,rd_now = rates(reqs[-1]["model"]) or rates(DEFAULT_MODEL)

    print(c(f"lenops view · {os.path.basename(path)[:8]} · {n} requests", "b"))

    hd("CONTEXT")
    used=cur/WINDOW; bn=int(round(used*30))
    kv("current", f"{c(f'{cur:>9,}','b')} {c('█'*bn+'░'*(30-bn),'c')} "
       f"{c(f'{100*used:.1f}%','r' if used>.8 else 'y' if used>.5 else 'g')} of {WINDOW//1000}k")
    kv("peak", f"{peak:>9,}")
    kv("free", f"{WINDOW-cur:>9,}")
    if n>1:
        per=(cur-ctxs[0])/max(1,n-1)
        kv("growth", f"{per:>9,.0f} tok/request",
           f"~{(0.8*WINDOW-cur)/per:,.0f} requests to the 80% mark" if per>0 else "")

    hd("PRELOAD")
    print(c("  the fixed prefix you pay for before saying anything", "d"))
    kv("floor", f"{floor:>9,}", f"{pct(floor,cur)} of the current context")
    kv("cost/req", f"${floor*p_now*rd_now/1e6:>8.4f}", "at cache-read rates, every request, forever")
    kv("conversation", f"{cur-floor:>9,}", "everything you and the tools have added since")

    hd("MODELS")
    for m,d in sorted(models.items(), key=lambda kv:-kv[1]["$"]):
        kv(m.replace("claude-",""), f"{d['n']:>4} req  ${d['$']:>7.2f}  {pct(d['$'],total)}",
           f"avg ctx {d['ctx']//d['n']:,}")
    kv("tier", ", ".join(sorted(tiers)) or "—")

    hd("COST")
    kv("total", c(f"${total:>8.2f}","b"), "API-list equivalent — subscription traffic is not billed per token")
    kv("per req", f"${total/n:>8.4f}")
    if span: kv("per hour", f"${total/(span/3600):>8.2f}")
    print()
    for lab,k,tok in (("cache read","read",cr),("cache write","write",w1+w5),
                      ("output","out",out),("fresh input","in",i_)):
        kv(lab, f"${money[k]:>8.2f}  {pct(money[k],total)}", f"{tok:>12,} tok")
    if think:
        kv("· thinking", f"${think_usd:>8.2f}  {pct(think,out)} of output", f"{think:>12,} tok")

    hd("CACHE")
    denom=cr+w1+w5+i_; hit=cr/denom if denom else 0
    kv("hit rate", c(f"{100*hit:>8.1f}%",'g' if hit>.9 else 'y'), f"{w1+w5:,} tok written")
    ratio = money["write"]/money["read"] if money["read"] else float("inf")
    pop = ("WRITE-HEAVY — 5m TTL is usually cheaper" if ratio>2 else
           "READ-HEAVY — 1h TTL is usually correct" if ratio<0.5 else
           "MIXED — sign is unstable here, trust C not the bucket")
    kv("write:read", f"{ratio:>8.2f}", pop+"   (SPEC §6.6)")
    kv("· in tokens", f"{(w1+w5)/cr if cr else 0:>8.2f}", "the intuitive ratio — it disagrees; dollars decide")
    kv("ttl 1h", f"${act:>8.2f}", "actual")
    kv("ttl 5m", f"${cf:>8.2f}",
       f"{c(f'{delta:+.2f}','g' if delta>0 else 'r')} — "
       f"{'5m would be cheaper' if delta>0 else '1h is cheaper'} · "
       f"{forced} forced re-write{'s' if forced!=1 else ''}")

    misses=[r["miss"] for r in reqs if r["miss"]]
    if misses:
        hd("WHY THE CACHE MISSED")
        print(c("  from the API's own diagnostics — measured cause, not inferred (ADR-0009)","d"))
        agg={}
        for m in misses:
            t=m.get("type","?"); d=agg.setdefault(t,[0,0])
            d[0]+=1; d[1]+=m.get("cache_missed_input_tokens",0)
        for t,(k_,tok) in sorted(agg.items(), key=lambda kv:-kv[1][1]):
            kv(t, f"{k_:>3}×  {tok:>9,} tok  ${tok*p_now*W1H/1e6:>7.2f}",
               "re-written at 1h rates" if tok else "no tokens lost", w=27)

    if turns:
        hd("LATENCY")
        v=sorted(turns); q=lambda f: v[min(len(v)-1,int(f*len(v)))]
        kv("turns", f"{len(v):>9}", "user message → final response, incl. all tool time")
        kv("p50", f"{hms(q(.5)):>9}")
        kv("p90", f"{hms(q(.9)):>9}")
        kv("max", c(f"{hms(v[-1]):>9}","y"), "slowest single turn")

    if gaps:
        hd("PACE")
        q=lambda f: gaps[min(len(gaps)-1,int(f*len(gaps)))]
        kv("span", f"{span/60:>8.1f} min")
        kv("gap", f"p50 {q(.5):.0f}s · p90 {q(.9):.0f}s · p95 {q(.95):.0f}s")
        kv(">5 min", f"{sum(1 for g in gaps if g>300):>8} of {len(gaps)}")

    hd("LEVERS")
    print(c("  headroom, not forecasts — only C is measured. See docs/experiments.md.","d"))
    A=TRIM*(money["read"]+money["write"]); B=EFFORT*think_usd; D=total-sonnet
    kv("A trim", f"${A:>8.2f}  {pct(A,total)}", f"{int(TRIM*100)}% less re-sent prefix — INVENTED %")
    kv("B effort", f"${B:>8.2f}  {pct(B,total)}", f"{int(EFFORT*100)}% fewer thinking tokens — INVENTED %")
    kv("C ttl-5m", f"${delta:>+8.2f}  {pct(abs(delta),total)}", "MEASURED against this trace")
    kv("D sonnet", f"${D:>8.2f}  {pct(D,total)}", "CEILING — assumes identical token counts")
    print()

def main():
    ap=argparse.ArgumentParser(prog="lenops")
    sub=ap.add_subparsers(dest="cmd")
    v=sub.add_parser("view", help="current session statistics")
    for p in (ap, v):
        p.add_argument("--session"); p.add_argument("--project")
        p.add_argument("--all", action="store_true")
    a=ap.parse_args()
    proj=a.project or os.path.expanduser("~/.claude/projects/"+os.getcwd().replace("/","-"))
    files=sorted(glob.glob(os.path.join(proj,"*.jsonl")), key=os.path.getmtime)
    if not files: sys.exit(f"no transcripts in {proj}")
    if a.session: files=[os.path.join(proj, a.session+".jsonl")]
    elif not a.all: files=[files[-1]]
    for f in files:
        reqs,turns = load(f)
        view(f, reqs, turns)

if __name__ == "__main__":
    main()
