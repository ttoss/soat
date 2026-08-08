---
description: "Learned Rules — human corrections captured from approval decisions, clustered for recurrence, and promoted into versioned scoped rules. Designed and deliberately deferred."
sidebar_label: Learned Rules (coming soon)
---

# Learned Rules

Corrections humans make to agent behavior, captured automatically, clustered when they
recur, and promoted by a human into versioned, scoped rules.

:::info Coming soon

This module is designed and **deliberately deferred** — it has no REST, MCP, CLI, or SDK
surface today. Its highest-value slice already shipped inside approvals as the read-only
[recurrence view](./approvals.md#recurrence-view). The rest builds only when two gates are
met, both listed under [Why it is deferred](#why-it-is-deferred).

:::

## Overview

An agent that keeps proposing the same wrong action, and a human who keeps correcting it
the same way, is a loop that never closes. The correction lives in a rejection reason, an
edited argument, or a chat message — none of which the next run reads.

Learned rules is the module for that material. The distinction that gives it a boundary is
worth stating precisely, because it decides where any piece of guidance belongs:

> **[Memories](./memories.md) are facts the agents learn about the world. Learned rules are
> corrections humans make to agent behavior.**

"Never quote a delivery date without checking stock" is not a fact about the world — it is
doctrine about how the agent should act, and it has a lifecycle a memory entry does not:
captured, clustered, **promoted by a human**, versioned, scoped, and eventually retired.

## Where it fits

Learned rules is part of the **ratchet** — the layer that governs how the system changes,
described in
[Harness, Loop, Graph, and Ratchet](../getting-started/harness-loop-graph-ratchet.md#layer-4--the-ratchet).
It is the half of that layer concerned with human corrections; [evaluations](./evaluations.md)
is the half concerned with measurement, and the two are coupled: a rule is soft context, so
only an eval can say whether injecting it changed anything.

## What it will own

**Candidate capture.** Every human correction becomes a reviewable candidate without anyone
filing it: a rejected [approval](./approvals.md) contributes its mandatory rejection reason,
an edit-then-approve contributes the argument diff ("the human changed this to that in this
situation"), and an explicit endpoint captures corrections that arrive through chat
surfaces. Each candidate keeps its provenance — the project, agent, run, and source
approval it came from.

**Recurrence detection.** Candidates are embedded and compared against each other with the
same vector similarity machinery [memories](./memories.md) uses, so *paraphrased*
corrections cluster together — which is precisely what the shipped exact-key recurrence view
cannot do. A cluster that crosses an occurrence threshold flags itself for promotion instead
of waiting for someone to reread the queue.

**Promotion lifecycle.** A human turns a candidate into a rule, usually editing the text
first, and chooses its scope: one project, or global across projects. Rules are versioned —
an update archives the prior text rather than overwriting it — and dismissal takes a reason,
so a rejected candidate is a decision on the record rather than a gap.

**Scoped rule listing.** Active rules are retrievable for a given project, ordered so the
most specific scope wins on conflict. Injecting them into an agent's context is the
consuming application's job, not the platform's — see
[context composition is the app's responsibility](#context-composition-stays-with-the-app).

## Key design decisions

### Promotion is human-curated, always

Automatically turning a free-text correction into a standing instruction is an unforced
error class: corrections are ambiguous, occasionally wrong, and permanent once they sit in
every prompt. The platform supplies the queue, the recurrence signal, and the evidence; a
human supplies the judgment. That is not a temporary limitation of the first version.

### Soft rules graduate to hard guardrails

A learned rule is **soft** — injected context the model is expected, but not forced, to
follow. Enforcement is not this module's job. When a constraint must *never* be violated,
the graduation path is a [guardrail](./guardrails.md) `deny`, which refuses the action
upstream so it never reaches the approval queue again. Two signals argue for graduating:
the same correction recurring after a rule already exists, and repeated rejections of the
same re-proposed action.

### Context composition stays with the app

SOAT owns identity, memory, retrieval, execution, orchestration, governance, and
provenance. Deciding *which doctrine to place in an agent's context, in what order, within
what budget* is application logic — the app owns its doctrine source, its versioning, and
its CI. So this module exposes rules for retrieval and stops there.

## Why it is deferred

Three findings moved the work back rather than forward:

1. **The capture substrate already persists.** Rejection reasons, edit diffs, and
   re-proposal chains live on every approval item permanently, so candidates can be
   backfilled whenever the module lands. Deferring costs almost no data.
2. **Exact recurrence needed no new models.** The highest-value output — "this correction
   happened four times, encode a guardrail `deny`" — falls out of grouping approval items by
   their dedup key, which is exactly what the shipped
   [recurrence view](./approvals.md#recurrence-view) does, with no AI-provider coupling in a
   deliberately deterministic module.
3. **Soft rules are unmeasurable without evals.** Proving that a rule reaches the next run
   proves plumbing, not behavior change. Shipping an injection surface whose effect cannot
   be measured is building on faith.

**Build gates — both must hold before this module is built:**

- The approvals recurrence view shows sustained demand: humans act on recurrence groups by
  creating guardrails from them, **and** hit the exact-match ceiling with paraphrased
  corrections the rollup cannot group.
- [Evaluations](./evaluations.md) ships, so a promoted rule's efficacy can be measured —
  run the regression set with the rule injected and without it — instead of assumed.

## What to use today

- **See what keeps coming back** — the approvals
  [recurrence view](./approvals.md#recurrence-view) groups repeated rejections with their
  reasons and the re-proposal chain, most-recurrent first.
- **Make a correction permanent and enforceable** — encode it as a
  [guardrail](./guardrails.md) `deny` or as a class that routes the action to
  [approvals](./approvals.md). See
  [Gate a Dangerous Tool with Guardrails](../tutorials/gate-a-tool-with-guardrails.md).
- **Make a correction permanent as guidance** — put it in the agent's `instructions`, which
  [agent versions](./agents.md#versioning-and-staged-rollout) archive on every write, so the
  change is attributable and reversible.
- **Store durable facts the agent should recall** — that is [memories](./memories.md), not
  this module.

## Track it

The full design — capture hooks, clustering thresholds, promotion lifecycle, and the
deferral reasoning — lives in
[`docs/prd-learned-rules.md`](https://github.com/ttoss/soat/blob/main/docs/prd-learned-rules.md),
and sequencing lives in
[`docs/roadmap.md`](https://github.com/ttoss/soat/blob/main/docs/roadmap.md).
