---
description: Run a task non-interactively in the opthub local sandbox, optimized for a goal, and compare it with the baseline
argument-hint: "[cost|latency|balanced] [conservative|balanced|aggressive] [task…]"
allowed-tools: Bash(opt claude -p:*)
---

Arguments: `$ARGUMENTS`

The user wants a task run by opthub: headless Claude Code in the local Docker sandbox, optimized
for a goal. opt proposes the change, runs the task with it and unchanged (the baseline) side by
side, and says whether the change is worth keeping. The sandbox gets a read-only copy of this
directory and exits when the task is done. Every run is recorded in opt's audit log.

Read the arguments as: an optional goal (`cost`, `latency` or `balanced`; default `cost`), an
optional temperature (`conservative`, `balanced`, `aggressive`, or a number 0–1; default
`balanced`), and then, optionally, the task in plain words. With no task in the arguments, the task
is the one this conversation is about.

Do this, without asking first:

1. Write the task as one self-contained instruction, as if for a new engineer who cannot see this
   conversation: the goal, the files involved, the constraints, and what "done" means. The run
   cannot ask questions, so settle every open question in the text. Keep it under 15 lines. Do
   not include secrets, tokens or personal data.
2. Run exactly one Bash command, with a 600000 ms timeout, passing the brief on stdin:

   ```
   opt claude -p --goal <goal> --temperature <temperature> --model <your own model id> --compare --repeats 3 --dir "$PWD" --task-file - <<'TASK'
   <the brief>
   TASK
   ```

   `--model` is the model you are running on (for example `claude-opus-5-5`), so the baseline
   matches this session.
3. Reply in at most eight short lines, from what opt printed:
   - the proposal, its risk, its best case and its worst case;
   - the verdict (keep it / drop it / inconclusive) and the measured change on the goal, with the
     baseline and optimized values;
   - whether the hidden check passed on both sides, and the task id.
   Do not copy files back into this directory unless the user asks.

If opt says nothing fits the goal at that temperature, show its reasons and suggest a higher
temperature. If it reports a missing credential or an authentication error, suggest `opt secrets`
and do not retry.
