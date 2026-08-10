---
description: "Evaluations — datasets, scorers, and scored runs that turn 'did this change make the agent better?' into a pass/fail verdict. Design complete, surface not yet built."
sidebar_label: Evaluations (coming soon)
---

# Evaluations

Repeatable, scored test suites for an agent: a dataset of cases, scorers that grade the
output, and runs comparable against a baseline.

:::info Coming soon

This module is designed but **not implemented**. There is no REST, MCP, CLI, or SDK surface
for it yet, and nothing on this page is callable today. It is documented here because the
concept is settled and it is the piece the rest of the
[ratchet layer](../getting-started/agent-system-layers.md#layer-4--the-ratchet)
depends on — see [What to use today](#what-to-use-today) for the shipped alternatives.

:::

## Overview

SOAT records what agents *did* — [traces](./traces.md), [generations](./generations.md),
[activity](./activity.md) — and constrains what they *may do* —
[guardrails](./guardrails.md), [approvals](./approvals.md), [quotas](./quotas.md). Both are
about a run that already happened or is happening. Neither answers the question an agent
author faces every time they reword an instruction, swap a model, or add a tool: **did that
make the agent worse?**

Traces are forensic. They explain one incident after the fact, and reading a handful of
manual conversations is not a measurement. Evaluations closes that gap with a verdict that
can gate a change.

## Where it fits

Evaluations is the foundation of the **ratchet** — the layer that governs how the system
changes, described in
[The Layers of an Agent System](../getting-started/agent-system-layers.md#layer-4--the-ratchet).
The loop asks whether a single run succeeded; an evaluation asks whether a *change* to the
agent improved the distribution of runs, which no single run can answer.

It is also the dependency two other capabilities wait on:

- **Eval-gated promotion** — a canary [release](./agents.md#staged-rollout) that promotes
  only when a scored run passes, rather than when someone decides it looks fine.
- **Reworded guidance** — an agent's `instructions` are soft context, so whether a change
  to them actually changed behavior is an empirical question. Without a regression set to run
  before and after, a rewording is a hunch with a
  [version number](./agents.md#versioning-and-staged-rollout) attached.

## What it will own

**Datasets.** Project-scoped collections of test cases. Each case holds the input messages,
optionally a reference answer, and free-form metadata for slicing results by topic. Cases
can be authored by hand or curated from real production traffic, so a dataset grows from
the incidents you actually had rather than from imagination.

**Scorers.** A scored run needs graders, and most useful ones are deterministic: exact or
substring match against a reference answer, a JSON Logic assertion over the input and
output, or validation of the agent's structured output against a schema. Where the
criterion is genuinely fuzzy, an LLM judge grades with a rubric and records its reasoning
for audit. Judges are ordinary completions — they meter and trace like any other call, and
comparing runs judged by different models is not meaningful.

**Runs.** A run executes the **real agent** against every case through the same generation
machinery production uses, so the verdict reflects the agent's true instructions, tools,
model, and knowledge. Each per-case result links its generation and trace, so a failing
score drills straight down to what the agent actually did.

**Baselines and gating.** A run can name an earlier run of the same evaluation as its
baseline, which turns raw scores into per-scorer deltas, and a pass threshold turns the
deltas into a single pass/fail verdict — the machine-checkable gate a promotion decision
can be attached to.

## Design constraints already settled

- **Eval runs spend real money.** Every case is a real generation and a judge doubles the
  calls, so eval spend is attributed separately from production spend in
  [usage](./usage.md) rollups, and run size is bounded.
- **Agents are stochastic.** A red run may be variance, not regression. Verdicts are taken
  over aggregates across a dataset, never a single case, with a pass threshold below `1.0`.
- **An un-evaluable run is an error, not a zero.** An agent that pauses for client-side
  tool execution has produced no output to grade; recording that as a score of zero would
  report a behavioral regression that did not happen.

## What to use today

Until this module ships, these shipped surfaces cover part of the same ground:

- **Attribute a behavior change to a config change** — [agent
  versions](./agents.md#versioning-and-staged-rollout) archive every config, and each
  generation records the `agent_version` that served it.
- **Limit a change's blast radius** — a [staged release](./agents.md#staged-rollout)
  splits traffic deterministically between a stable and a canary version. See
  [Agent Versioning and Canary Rollout](../tutorials/agent-versioning-and-canary-rollout.md).
- **Compare runs by hand** — [traces](./traces.md) and [generations](./generations.md)
  hold the reasoning steps, tool calls, and token usage of every run.
- **Catch a regression in production** — [guardrails](./guardrails.md) classify tool calls
  from their real arguments, and [exceptions](./exceptions.md) file what went wrong as
  triageable items.

## Track it

The full design — data model, scorer semantics, execution model, and phasing — lives in
[`docs/prd-evaluations.md`](https://github.com/ttoss/soat/blob/main/docs/prd-evaluations.md),
and sequencing lives in
[`docs/roadmap.md`](https://github.com/ttoss/soat/blob/main/docs/roadmap.md).
