---
name: investor-case
description: An autonomous flow that writes a user story, builds the investor case for centralised multi-dimensional AI optimization, and puts it before a judge.
methodology: investor.md
goal: Convince an investor that AI optimization spans many dimensions - routing, caching, context compaction, prompt and tool-schema shaping, observability and attribution - and that because no one dimension is sufficient, responsibility belongs with the workload owner via a central solution rather than scattered across teams.
stages: story build judge
budget_story: 2
budget_build: 5
budget_judge: 3
---

## story

Write `STORY.md`: a GitHub-ready user story that defines the goal precisely
enough that someone else could execute it without asking questions.

Shape: a title, a one-paragraph problem statement, `As a / I want / So that`,
then acceptance criteria, then a "Definition of done".

**Constraints on the acceptance criteria — these matter more than the story:**

* **At most 8 criteria.** A long list is not rigour; it is a builder guaranteed
  to spend its budget satisfying mechanics instead of making the argument.
* **Each must be about substance** — what the argument must establish, what it
  must not assume, what a sceptical reader must be able to check.
* **Do not specify word counts, exact section names, exact table shapes, or
  citation formats.** Those are the criteria that get gamed rather than met.
* **Do not require external sources or citations.** The builder will have no web
  access; it must reason from what it knows and mark uncertainty honestly.
* **The deliverable is exactly `CASE.md` in the working directory.** Do not
  rename it, do not nest it in a folder, do not invent a different filename.

A good criterion: "states what would have to be true for the central-ownership
conclusion to be wrong." A bad one: "body is between 1,200 and 1,800 words."

## build

Read `STORY.md` and produce **`CASE.md`** in the working directory — the
artifact it describes: the argument for the goal, aimed at an investor.

You have no web access. Reason from what you know and mark anything uncertain
as uncertain; an invented citation is worse than an acknowledged gap.

Write the document once, well. Do not iterate on mechanical properties like
length — no reader has ever been persuaded by a word count.

Every acceptance criterion in `STORY.md` must be satisfied. You are being graded
against a methodology you cannot see, but you already know its most important
rule from the story you wrote: claims must be grounded, the counter-case must be
present, and the ask must be legible.

## judge

Do not write anything. This stage is executed by a separate sandbox that has
never seen the other stages' reasoning.
