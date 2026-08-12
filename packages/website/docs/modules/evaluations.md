---
description: "Evaluations — datasets, scorers, and scored runs that turn 'did this change make the agent better?' into a pass/fail verdict in SOAT."
---

# Evaluations

Repeatable, scored test suites for an agent: a dataset of cases, scorers that grade the
output, and runs that produce a pass/fail verdict.

## Overview

SOAT records what agents *did* — [traces](./traces.md), [generations](./generations.md),
[activity](./activity.md) — and constrains what they *may do* —
[guardrails](./guardrails.md), [approvals](./approvals.md), [quotas](./quotas.md). Both are
about a run that already happened or is happening. Neither answers the question an agent
author faces every time they reword an instruction, swap a model, or add a tool: **did that
make the agent worse?**

An evaluation answers it. A **dataset** holds test cases, an **eval** binds an agent to a
dataset and a list of **scorers**, and a **run** executes the real agent against every case
and scores the outputs.

Evaluations is the foundation of the **ratchet** — the layer that governs how the system
changes, described in
[The Layers of an Agent System](../getting-started/agent-system-layers.md#layer-4--the-ratchet).
The loop asks whether a single run succeeded; an evaluation asks whether a *change* to the
agent improved the distribution of runs, which no single run can answer.

:::info[Phase 1]

Datasets, evals, and **synchronous** runs with the four deterministic scorers are shipped.
Three things are specified and not yet built: the `llm_judge` scorer, asynchronous runs
(`wait: false`), and baseline **deltas** — a `baseline_run_id` is validated and recorded
today, but the per-scorer deltas it feeds arrive with Phase 2. Each is rejected by name
rather than silently ignored. See
[`docs/prd-evaluations.md`](https://github.com/ttoss/soat/blob/main/docs/prd-evaluations.md).

:::

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Dataset

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `dset_…`) |
| `project_id` | string | ID of the owning project |
| `name` | string | Unique within the project |
| `description` | string | Optional free text |
| `created_at` / `updated_at` | string | ISO 8601 timestamps |

Deleting a dataset deletes its items **and** the evals bound to it — an eval whose dataset
is gone has nothing to run.

### Dataset item

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `dsit_…`) |
| `dataset_id` | string | ID of the owning dataset |
| `input` | array | `{ role, content }` messages, replayed verbatim as the generation's input |
| `expected_output` | string | Reference answer for `exact_match` (and, in Phase 2, `llm_judge`); may be `null` |
| `metadata` | object | Free-form tags (e.g. `{"topic": "billing"}`), opaque to the platform and readable from `json_logic` scorers |
| `source_generation_id` | string | The generation the item was curated from. Always `null` until the `from-generation` route lands in Phase 2 |
| `created_at` / `updated_at` | string | ISO 8601 timestamps |

### Eval

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `eval_…`) |
| `project_id` | string | ID of the owning project |
| `name` | string | Unique within the project |
| `agent_id` | string | The agent under test — must be in the same project |
| `dataset_id` | string | The dataset to run it against — must be in the same project |
| `scorers` | array | Scorer configs; see [Scorers](#scorers) |
| `pass_threshold` | number | 0–1, or `null` to report without gating; see [Pass semantics](#pass-semantics) |
| `created_at` / `updated_at` | string | ISO 8601 timestamps |

An `agent_id` or `dataset_id` naming a resource in another project is rejected with `400`
naming the field — the resource may well exist, it is the request that is wrong.

### Eval run

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `evrun_…`) |
| `eval_id` | string | ID of the eval this run belongs to |
| `agent_version` | integer | The one agent version every item ran against; see [Version pinning](#version-pinning) |
| `status` | string | `queued` \| `running` \| `completed` \| `failed` \| `canceled` |
| `baseline_run_id` | string | A terminal run of the same eval, or `null` |
| `aggregate_scores` | object | Per-scorer `mean` / `pass_rate`, the run `pass_rate`, and `scored_item_count`; `null` until the run is terminal |
| `passed` | boolean | The verdict; `null` when the eval declares no `pass_threshold` |
| `item_count` / `completed_count` / `errored_count` | integer | Items attempted, scored, and errored |
| `started_at` / `finished_at` | string | ISO 8601 timestamps, `null` until set |
| `created_at` | string | ISO 8601 creation timestamp |

### Eval result

One row per dataset item per run.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `evres_…`) |
| `eval_run_id` | string | ID of the run |
| `dataset_item_id` | string | The item this scored; `null` once that item is deleted |
| `input` | array | **Frozen copy** of the item's input at run time |
| `expected_output` | string | **Frozen copy** of the item's expected output at run time |
| `generation_id` | string | The generation that produced the output, or `null` |
| `output` | string | The agent's final output text; cleared when the linked generation's content is [purged](#retention-and-erasure) |
| `scores` | array | `[{ scorer, score, passed }]`, one entry per scorer |
| `passed` | boolean | AND over the per-scorer `passed` flags |
| `error` | string | Item-level failure reason; set instead of scoring, never alongside it |
| `created_at` | string | ISO 8601 creation timestamp |

## Key Concepts

### Scorers

`scorers` is a discriminated union on `type`. Each type may appear **at most once** per
eval, because aggregate scores are keyed by type. Every scorer produces
`{ score: 0–1, passed: boolean }` — binary scorers emit 0 or 1 — so aggregation and
thresholds stay scorer-agnostic.

| `type` | Config | Scores |
| --- | --- | --- |
| `exact_match` | — | 1 when the trimmed output text equals `expected_output`; an item with no reference answer cannot pass |
| `contains` | `value`, `case_sensitive` (default `false`) | 1 when `value` occurs in the output text |
| `json_logic` | `expression` | 1 when the [JSON Logic](https://jsonlogic.com) expression evaluates truthy |
| `output_schema` | `schema` (optional) | 1 when the structured output validates against the schema |
| `llm_judge` | — | **Phase 2.** Rejected with `400` naming the phase |

A scorer reads the generation's two output channels explicitly. `exact_match` and
`contains` read the final **text**; `output_schema` validates the **structured object** the
platform already parsed, and never re-parses the text.

`json_logic` sees both, through these variables:

| Var | Value |
| --- | --- |
| `input` | The item's input messages |
| `output` | The final output text |
| `object` | The structured output. **Absent** when the agent has no `output_schema` — an expression over it evaluates falsy rather than erroring |
| `expected` | The item's `expected_output` |
| `item.metadata` | The item's metadata bag |

It uses the same shared `LogicEngine` as orchestration mappings, so assertion semantics are
identical everywhere.

#### Why `output_schema` requires an agent schema

An `output_schema` scorer is rejected with `400` unless the **agent under test** carries an
`output_schema` — even when the scorer supplies its own `schema`. The platform only
produces structured output when the agent's schema constrains the model; against an
unconstrained agent the object would be permanently absent and the scorer would report 0 on
every item of every run. That is a fabricated regression, which is the exact signal this
module exists to prevent.

The two schemas play distinct roles: the **agent's** decides whether structured output is
produced at all; the **scorer's** is the frozen criterion it is judged against. The check
runs at eval-create (best-effort — the agent's schema is mutable) and again at run start,
which is authoritative.

### Frozen inputs

Dataset items keep full CRUD, and a run does not depend on them staying put: each result
carries its own copy of the item's `input` and `expected_output`, taken at run time.
Without that copy, editing or deleting an item between two runs would silently make their
scores incomparable — and a baseline delta would report **dataset drift as agent
regression**. Deleting an item nulls `dataset_item_id` on past results and changes nothing
else.

### Version pinning

A run resolves **one** agent version at run start, stamps it on `agent_version`, and every
item executes against it.

- Pass `agent_version` to name an archived [version](./agents.md#versioning-and-staged-rollout) —
  this is how a canary is evaluated before promotion. An unknown version is a `400`.
- Omit it and the run uses the [active release's](./agents.md#staged-rollout) **stable**
  version, or the live draft version when no release is in effect.

Pinning is not a convenience. Release assignment keys on the session's actor; an eval
generation has no session, so an unpinned run would get a **random bucket per item** and
blend two configs into a single score.

### Pass semantics

Three levels, each derived from the one below:

1. **Per scorer, per item** — a binary scorer passes when its score is 1.
2. **Per item** — `EvalResult.passed` is the AND over its per-scorer flags.
3. **Per run** — `EvalRun.passed` is `null` when the eval has no `pass_threshold`;
   otherwise it is true when the **pass rate** — passed items over non-errored items — is
   at least the threshold.

The verdict gates on the pass rate, never on a pooled mean: pooling 0/1 binaries with 0–1
judge fractions produces a unit-less number whose meaning shifts whenever a scorer is added.
`aggregate_scores` still reports per-scorer means, so the continuous signal is not lost — it
just does not gate. A run that scored nothing at all does not pass.

### Errors are not zeros

An item whose generation did not complete is recorded as an **error**, excluded from
`aggregate_scores`, and counted in `errored_count` — it is never scored 0. The common case
is an agent with client-side tools pausing for tool outputs (`requires_action`): it produced
no output to grade, and scoring that 0 would report a behavioral regression that did not
happen. Agents whose tool set forces a client round-trip stay un-evaluable until a later
phase can supply synthetic tool outputs.

### Synchronous runs

`wait` is **required** and must be `true`. The run executes items sequentially and reaches
a terminal status before the response returns.

- `wait: false` returns `400` naming asynchronous runs as a Phase 2 capability. Requiring
  the field now means that same request flips to a `queued` run **additively** when the
  queue lands, instead of silently changing what an omitted field means in the one field
  callers gate deployments on.
- A dataset larger than **25 items** is rejected with `400` naming the cap, rather than
  scored partially — a subset reported as the run's verdict would read as a complete
  pass/fail over the whole dataset. This `400` is stable across phases.
- An **empty** dataset is rejected too: a run that measured nothing must not produce a
  verdict.

A client that disconnects mid-run leaves the run row `running` — queryable with `started_at`
set and `finished_at` null. Phase 2's lease reaper closes that gap; nothing retries or
cleans the row today.

### Retention and erasure

`EvalResult.output` is a copy of a generation's content on another table, so purging that
generation's content — directly, or through its trace — also clears the copy. Scores,
`passed`, and the frozen `input` / `expected_output` survive, so run aggregates remain
meaningful after an erasure.

**Datasets sit on the other side of that line.** They are operator-owned test fixtures, and
a content purge never deletes or mutates a dataset item — including one curated from a
generation. A test suite must not silently stop being runnable because of an unrelated
erasure request; an erasure covering curated content requires deleting the item explicitly.

## Examples

Create a dataset and add a case:

```bash
soat create-dataset --project_id "$PROJECT_ID" --name billing-regressions

soat create-dataset-item --dataset_id "$DATASET_ID" \
  --input '[{"role":"user","content":"When is my invoice issued?"}]' \
  --expected_output "On the first of each month." \
  --metadata '{"topic":"billing"}'
```

Bind an eval and gate it at an 80% pass rate:

```bash
soat create-eval --project_id "$PROJECT_ID" --name billing-regression-suite \
  --agent_id "$AGENT_ID" --dataset_id "$DATASET_ID" \
  --scorers '[{"type":"contains","value":"first of each month"}]' \
  --pass_threshold 0.8
```

Run it and read the per-item results:

```bash
soat start-eval-run --eval_id "$EVAL_ID" --wait true
soat list-eval-results --eval_id "$EVAL_ID" --run_id "$RUN_ID"
```

Evaluate a specific archived version — the shape a promotion gate uses:

```bash
soat start-eval-run --eval_id "$EVAL_ID" --wait true --agent_version 3
```

## What is not here yet

- **`llm_judge`, async runs, baseline deltas, and `from-generation` curation** — Phase 2.
- **Scheduled evals and `eval` / `dataset` formation resources** — Phase 3.
- **Eval-gated promotion** — a canary [release](./agents.md#staged-rollout) that promotes
  only when a scored run passes. It consumes this module's verdict; see
  [`docs/prd-agent-versions.md`](https://github.com/ttoss/soat/blob/main/docs/prd-agent-versions.md).

Sequencing lives in
[`docs/roadmap.md`](https://github.com/ttoss/soat/blob/main/docs/roadmap.md).
