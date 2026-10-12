# Session graph

*2026-10-12. Preview: [`docs/preview/session-graph/`](preview/session-graph/). Parser:
[`tools/sessiongraph.py`](../tools/sessiongraph.py). Shared pages are listed in
[`ARTIFACTS.md`](ARTIFACTS.md).*

A session as a graph of **tasks**. A task is one person's prompt and everything the agent did
until the next one. Each task links to the model that ran it, the context it carried, the tools
it called, and the files, commands and subagents those tools touched. The ledger tools answer
*how much*. The graph answers *where it went and why*.

---

## 1. What it answers

| question | where on the graph |
|---|---|
| Which task cost the most, and what did it carry? | circle area = cost; context bar = largest single request's input |
| How fast does context ratchet from task to task? | the spine between tasks thickens with the next task's context |
| Which tasks could run on a cheaper model, and which are locked? | dashed teal edge = routable by policy; dashed red = never-downgrade |
| What did the agent re-read that it already had? | `re-read` signal on the task, the file node lights up across tasks |
| Which files did a task write, and with which tools? | amber edges to file nodes, `+add −rm` in the detail panel |
| Where did the money go outside the main thread? | subagent nodes, with their own requests and cost |

Click any node to fade out everything not connected to it. A task opens its numbers and every
call in order; a file, tool or model lists the tasks that used it.

## 2. Model

| node | from | encoding |
|---|---|---|
| **task** | a person's prompt (not meta, not a tool result, not command or notification noise) up to the next one | circle, area ∝ cost; class chip; signal dots |
| **context** | max over the task's requests of `input + cache_read + cache_creation` | bar, height ∝ tokens |
| **model** | `message.model` of the task's requests, subagents included | pill; edge weight = requests |
| **tool** | `tool_use.name`; MCP tools collapse to `mcp:<server>` | box; edge width ∝ calls |
| **file / dir** | `file_path` of Read/Edit/Write, `path` of Grep/Glob | read = grey edge, write = amber edge |
| **command** | Bash command *family*: `git diff`, `npm test`, `kubectl apply` | pill |
| **subagents** | `<session>/subagents/**/*.jsonl`, charged to the task running when they started | teal box; requests and cost in the panel |

**Counting.** A transcript writes one record per content block, and each record carries the
same message id and identical usage. Requests are counted once per message id. The
ledger tools do not do this yet (see §6). Cost is `tools/sessions.py`'s `req_cost`: list-price
equivalent, label `priced`, not a bill.

## 3. Signals on a task

| signal | label | rule |
|---|---|---|
| `re-read` | detector | a file this task reads was already read by an earlier task |
| `tool errors` | measured | count of `tool_result.is_error` |
| `compacted` | measured | a `compact_boundary` or `summary` record inside the task |
| `subagents` | priced | subagent count and their cost |
| `routable` / `never-downgrade` | policy | mock only: the beat's class against policy v14 (`demo-mock-spec.md` §5) |

**Class.** In the mock, class is the session-view class from §5 (`coding/edit`,
`review/security`, …). On a real transcript it is the task's *activity*, from its tool mix:
`edit` if it wrote, `run` if shell calls dominate, `explore` if it only read or searched, `chat`
if it called nothing. Routing state on a real transcript is `unknown` until per-task Jev labels
exist (§7).

## 4. Privacy

Stripped by default: no prompt text, no tool inputs, no absolute paths. Files become paths
relative to the session's cwd, or `…/basename` outside it. Shell commands keep only their
family. Web and MCP calls keep only the tool name. `--keep-text` adds prompt titles and
command lines, with secrets and e-mail addresses masked, and **refuses to write anywhere but
`data/private/`** (gitignored).

## 5. Commands

```sh
python3 tools/sessiongraph.py 8f73f7f5                                  # summary; id prefix or .jsonl path
python3 tools/sessiongraph.py 8f73f7f5 -o data/private/g.json           # graph JSON
python3 tools/sessiongraph.py 8f73f7f5 --html data/private/g.html       # Triage page for one session
python3 tools/sessiongraph.py 8f73f7f5 --html data/private/g.html --page session   # graph only
python3 docs/preview/session-graph/build.py                             # rebuild the mock previews from §5

cd experiments/session-triage && python3 src/export_hub.py              # triage.json + results/graphs/<sid>.json
```

## 6. Hub → Triage → session → Graph

**Done in this repo.** `experiments/session-triage/src/export_hub.py` now writes a stripped
graph for every session whose transcript still exists, to `results/graphs/<session>.json`
beside `triage.json`. Each record gets a `graph` field holding that relative path, or `null`
when the transcript has expired or the session has no id. `--no-graphs` skips them.
End-to-end on this machine: 1 of 1 sessions written, rules arm, no egress.

**Needed in `sandbox/e2b`.** That repo isn't on GitHub, so these changes are not made here.
A ready-to-paste prompt for Claude Code in that repo is in
[`prompts/hub-triage-graph.md`](prompts/hub-triage-graph.md).

1. `hub.mjs`: `GET /api/triage/:sid/graph` returns `results/graphs/<sid>.json`, or 404 when
   the record's `graph` is null.
2. `hub.mjs`: `GET /triage/:sid/graph` serves
   `docs/preview/session-graph/triage-graph.template.html` with `/*GRAPH*/null` replaced by
   that JSON. This is the same substitution `sessiongraph.py --html` does, so the page needs
   no build step.
3. `lib/hub-page.mjs`: in the Triage session detail, add a **Graph** link next to the
   classes. Disable it when `graph` is null. It opens the page full width, the way Sessions →
   Analytics does (screen 06), because the graph does not fit the 380px detail pane.

**Known gap: the costs disagree.** In the same export run on this session, Triage shows $15.42 (ledger from
`tools/savings.py`) while the graph shows $11.39, including $4.40 of subagents. The ledger
counts every record that carries usage, which double-counts requests split across content
blocks. The main transcript of this session held 134 usage records against 62 unique
message ids when this was written, mid-session. It also skips
subagent files. Whether the pinned E1/E1b ledgers are affected depends on whether the August
transcripts already split records per block. That needs checking before any number in
`docs/` moves.

## 7. Next

- **Per-task labels.** Run Jev, or the rules arm, per task instead of per session. Then
  `routable` / `never-downgrade` work on real sessions as they do in the mock.
- **Carried-but-unused context.** Tool results from earlier tasks whose files and commands
  this task never touches. This is the `context-lifecycle` headroom, the top lever, drawn
  where it happens.
- **Unverified write.** A code write with no test or build run after it in the same task.
- **Compaction loss.** Files re-read after a compaction that the agent had read before it.
- **Arms as two graphs.** A replay's `baseline` and `exp1` laid out on the same task spine,
  with each edge marked same, changed or missing. Arms are compared with each other, never
  with the original session.
- **DevOps / CloudOps sessions.** The command family already separates `kubectl get` from
  `kubectl apply` and `terraform plan` from `terraform apply`. Next is a `mutates` signal on
  apply / delete / upgrade / rollout, so change risk shows on the task that caused it.
- **Scale.** Past about 60 tasks, group them into topic bands (the `TOPIC_GAP_S` rule in
  `experiments/session-triage/src/extract.py`). Only the 36 most-touched files are drawn;
  the page says how many were dropped.
