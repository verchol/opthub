# J2 — email triage with Jev

*Spec + working harness, 2026-09-25. Series **J** (judge/decision calibration), separate
from the **E** series (cost levers) and from [J1](../../docs/judge-calibration-spec.md).*

Classification is the Choice primitive's native shape: pick one option from a fixed set,
return a probability per option and a confidence. This is the cheapest honest way to find
out whether Jev's decisions are worth anything on a real workload.

---

## 1. Motivation

**The question.** On one real mailbox, does a decision model beat a twenty-line rule file
at working out what each email needs — and does giving it *local context* it could not
otherwise have change the answer?

**Why this mailbox is a good test.** Two things about it decide the whole design:

1. **It is ~85% bulk.** Of 25,204 inbox messages, the recent sample is overwhelmingly
   newsletters, digests and vendor marketing. A classifier that answers `archive` every
   time scores ~0.85 accuracy and is useless. **Accuracy is therefore not a metric here**;
   it is reported only to show how misleading it is.
2. **The errors are asymmetric.** Filing a newsletter wrongly costs nothing. Missing an
   invoice, a meeting, a security alert or a person waiting on a reply costs real money or
   real trust. The number that decides anything is **recall on the action-critical
   classes**, not overall score.

**Why it is worth doing at all.** The existing `triage/*` labels in the mailbox are not
trustworthy ground truth — one Medium digest carries eight labels including both
`priority-low` and `priority-medium`, which is a contradiction, so they read as an earlier
automated pass that over-applied. Any claim that a model "works" on this mailbox has, so
far, nothing behind it. This builds the smallest thing that can settle it.

**What it is not.** Not an inbox automation. Nothing in this harness labels, archives or
replies to anything. It reads an exported corpus and writes a score.

### 1.1 The real finding this is built to expose

On a mailbox this bulk-heavy, **the deterministic rules are the thing to beat, and they are
cheap to beat on volume and hard to beat on value.** The rules baseline already abstains on
only 24% of the synthetic corpus at zero cost and zero latency — but its recall on
action-critical mail is 0.50. It handles the mail that does not matter and misses half the
mail that does.

So the interesting arm is not "model vs rules". It is **rules first, model only where the
rules abstain** — which is opthub's own thesis (`SPEC.md` §6.7, detector-first) applied to a
different workload. An arm that sends all 25,204 messages to an external model, when a
sender-domain check settles 76% of them for free, is the wrong design even if it scores well.

---

## 2. The taxonomy — four axes, not one flat list

The mailbox's existing labels conflate three independent questions into one namespace
(`triage/vendor` is a *relationship*, `triage/devops` is a *topic*, `triage/priority-low` is
a *priority*). A Choice model picks one option per question, so the fix is to ask several
questions, not to invent a twenty-way label.

Jev takes multiple questions in **one request**, so this costs one call, not four.

| axis | options | why it exists |
|---|---|---|
| **lane** | `work` · `personal` · `both` · `unclear` | the job/personal split; missing from the current labels entirely, though the mailbox clearly contains both |
| **relation** | `known-human` · `new-human` · `automated-transactional` · `automated-bulk` · `unclear` | collapses eight existing relationship labels into the distinction that actually changes behaviour: is a person waiting, and have we met? |
| **action** | `reply` · `schedule` · `pay-or-sign` · `security` · `read-later` · `archive` | replaces `priority-high/medium/low`, which say how much to care but not what to do |
| **topic** | `ai-agents` · `devops-cloud` · `business-gtm` · `finance-admin` · `personal-life` · `other` | keeps the existing topic labels, for filtering rather than triage |

`action_critical = [reply, schedule, pay-or-sign, security]` — the four where a miss is
expensive. Defined in [`taxonomy.json`](taxonomy.json).

**The criteria text is a measured variable, not fixed harness.** Alexei's `pi-model-router`
moved Jev's confidence from ~30% to ~90% on identical inputs purely by rewording the option
descriptions ([`docs/router-comparison.md`](../../docs/router-comparison.md) §1). Any result
here that is not tested against a reworded `taxonomy.json` is measuring the prompt author.

---

## 3. The context assist — the actual hypothesis

A gateway sitting in the request path sees the email. It does not see **what this mailbox
knows about the sender.** That local knowledge is computed in
[`src/features.py`](src/features.py) from Gmail metadata only — never message text:

| feature | why it should matter |
|---|---|
| `i_ever_replied_to_sender` | the single strongest signal that a reply is expected again |
| `msgs_from_sender` | 200 messages and no reply ever = bulk, whatever the subject says |
| `addressed_directly` | on `To:` with ≤3 recipients, versus one of a thousand |
| `days_since_first_contact` | a first-time human reads differently from a five-year vendor |
| `thread_len` | a live thread outranks a cold subject line |
| `looks_bulk_by_domain`, `sender_domain_seen_before`, `i_am_only_recipient` | cheap structural priors |

**Arms differ only in whether this block is present.** `C0` is what a central gateway could
see; `C1` adds the local context. If C1 does not beat C0, the local-decision argument in
`docs/demo-mock-spec.md` (claim C1) loses its best evidence, and that is worth knowing.

---

## 4. Arms

| arm | classifier | context | cost | what it answers |
|---|---|---|---|---|
| `rules` | 20 lines of sender/subject checks | yes | free, 0 ms | the bar everything must clear |
| `jev-C0` | Jev `jev-1.13.0` | no | paid | can a decision model read an email cold? |
| `jev-C1` | Jev `jev-1.13.0` | **yes** | paid | does local context change its mind? |
| `haiku-C0` / `haiku-C1` | Claude Haiku 4.5 via LangChain | no / yes | paid | is a Choice model better than a chat model at choosing? |
| `local-C1` | `qwen3:8b` via Ollama | yes | **free** | how much is lost by never leaving the laptop? |

Arms are named for what they vary. Two arms that resolve to the same inputs are reported as
**no change**, and any delta between them is the noise floor, not a finding — the same rule
the opthub experiment loop already applies.

---

## 5. Metrics

Per arm, per axis (`src/score.py`):

- **macro-F1** — the headline; treats `security` (2 messages) as seriously as
  `automated-bulk` (thousands)
- **action-critical recall** — the number that decides anything
- **abstain rate** and **accuracy when answered** — an arm that abstains often but is right
  when it speaks is usable in front of a rules fallback; one that is confidently wrong is not
- **accuracy** — reported and labelled misleading
- **cost per 1,000 emails**, **p50/p95 latency**, **outcome counts** (`ok` / `invalid` /
  `http-*` / `unavailable`)
- **confidence calibration** — Jev's confidence is decisiveness across options, *not* the
  chance it is right. Whether the two correlate at all is a secondary output, and until it is
  measured, confidence never gates anything.

Scale check: at 25,204 messages, an arm costing $0.40/1k is ~$10 to classify the mailbox
once. The rules arm is $0. That ratio is the whole economic argument for detector-first.

---

## 6. The Jev request

One request, four questions. Built in [`src/classifiers/jev.py`](src/classifiers/jev.py);
print the exact payload with `python3 src/run.py --dry-run`.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "email": {
      "id": "s01",
      "sender_domain": "substack.com",
      "sender_local_class": "marketing",
      "sender_is_self": false,
      "subject": "The Billion-Dollar Formula",
      "snippet": "The two numbers behind a breakout startup and a practical kit to test yours",
      "lang": "other"
    },
    "sender_context": {
      "msgs_from_sender": 2,
      "i_ever_replied_to_sender": false,
      "days_since_first_contact": 0,
      "addressed_directly": false,
      "thread_len": 1,
      "looks_bulk_by_domain": true,
      "sender_domain_seen_before": true,
      "i_am_only_recipient": true
    },
    "context_note": "sender_context is computed locally from this mailbox's own metadata. It describes the correspondence history, not the message text."
  },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "What does this need from Oleg? Choose exactly one option. Choose the option whose description fits the evidence, not the one that sounds most important.",
      "criteria": {
        "reply": "A person is waiting for a written answer from Oleg.",
        "schedule": "A meeting to accept, decline, move or propose.",
        "pay-or-sign": "Money or signature: invoice, renewal, failed payment, contract, legal document.",
        "security": "Account security: login alert, verification code, password reset, breach notice, suspicious activity.",
        "read-later": "Worth Oleg's attention but needs no action and has no deadline.",
        "archive": "No action now or later; safe to file away unread."
      }
    }
  }
}
```

*(`lane`, `relation` and `topic` are three more entries in the same `questions` map.)*

**Response, and what is kept**

```json
{
  "answers": {
    "action": {
      "type": "choice",
      "choice": "read-later",
      "probabilities": {"reply": 0.01, "schedule": 0.01, "pay-or-sign": 0.01,
                        "security": 0.01, "read-later": 0.91, "archive": 0.05},
      "confidence": 0.88
    }
  }
}
```

Validation follows `extensions/jev.ts` in Alexei's repo, which is a good working reference:

- the choice must be one of the **supplied option ids** for that axis, nothing else
- `probabilities` must cover **exactly** the option set and sum to 1 ± 0.01
- the chosen option must hold the maximum probability
- **no retry, no second classifier.** A failure is `unavailable` and the arm abstains; it
  does not silently fall through to rules and claim the rules' score
- nothing from the response is kept except the validated choice and the two numbers. No
  explanation text, no model echo, no raw body is ever written to disk

---

## 7. Privacy — the part that needs a decision, not a default

Jev is a third party. Sending mail to it is a real disclosure, and no amount of pattern
matching makes that untrue.

What the harness does:

- **The sandbox never holds mail credentials.** Export runs on the host
  (`src/export.py`), the container sees an already-redacted corpus.
- **`src/redact.py` runs before anything leaves the machine**: URLs, addresses, phone
  numbers, amounts, long numbers and code-shaped tokens are replaced; the snippet is capped
  at 400 characters; the sender's local part is reduced to a *class*
  (`noreply` / `billing` / `security` / `marketing` / `person`) so the signal survives and the
  identity does not.
- **Bodies are never exported.** Subject plus snippet is the whole payload.
- **`data/private/` is gitignored** — `demos/opthub` is a public repository, and the
  committed corpus is synthetic ([`data/seed-synthetic.jsonl`](data/seed-synthetic.jsonl)),
  shaped like the real mailbox but containing no real mail.
- **Egress is allow-listed per arm** in `sandbox/run.sh`: the `rules` and `local` arms run
  with no external egress at all.

What it does not do, stated plainly: **this is not a redaction service.** A snippet can still
contain a name, a deal, a diagnosis. The `local-C1` arm exists so that the whole question can
be sidestepped — it never leaves the laptop. If the numbers say the local model is close,
that is the answer, not a consolation.

**Per-lane opt-in is the right control**, borrowed from Alexei's work-profile rule: approve
`work` mail to an external advisor without thereby approving `personal`.

---

## 8. Running it

```sh
# free, offline, no keys — the baseline
python3 src/run.py --arms rules

# see the exact payload before sending anything anywhere
python3 src/run.py --dry-run

# in the sandbox: read-only source, caps dropped, egress per arm
ARMS=rules ./sandbox/run.sh
JEV_API_KEY=... ARMS=rules,jev ./sandbox/run.sh
ANTHROPIC_API_KEY=... ARMS=rules,jev,llm ./sandbox/run.sh
```

Current state on the 18-message synthetic corpus:

```
rules   macro-F1(action)=0.536  critical-recall=0.50  abstain=0.24  p50=0ms  $0.00/1k
```

The rules handle the bulk and miss half of what matters. Every other arm is measured against
exactly that.

---

## 9. Limits — written as limits

- **The gold labels are mine, not yours.** The 18 synthetic records were labelled by me from
  the shape of your real mail. Before any number here means anything, you need to label a real
  set — and disagreement between your labels and mine on the same message is itself a finding
  about how well-posed the taxonomy is.
- **18 messages is a smoke test, not a sample.** Useful for checking the harness runs.
  Meaningless for comparing arms. ~300 labelled messages with the rare classes deliberately
  over-sampled is the minimum, because `security` and `pay-or-sign` are a handful of messages
  in thousands.
- **One mailbox, one person.** The same standing limit as everything else in this repo.
- **`n = 1` per email.** No repeats, so a small gap between arms is noise. The same discipline
  the E series already carries.
- **The existing `triage/*` labels are a prior, not truth**, for the reason in §1.

---

## 10. Open questions

1. Should `personal` mail ever go to an external advisor at all, or is `local-C1` the only
   arm allowed to see it? Leaning: personal is local-only, and the cost of that is measured
   rather than assumed.
2. Is `both` a real lane or a dodge? If Jev picks it often, the option is doing work; if it
   never picks it, remove it.
3. Should the rules abstain more aggressively, so the model is always asked on anything
   human-shaped? That trades cost for recall on exactly the expensive classes.
4. Does `action` even need a model once `relation` is known? If `automated-bulk` →
   `read-later|archive` is nearly deterministic, the model is only needed for two axes, and
   the request gets cheaper.
