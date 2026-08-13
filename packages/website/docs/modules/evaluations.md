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

:::info[Fully shipped]

Datasets, evals, all five scorers (including `llm_judge`), synchronous **and** queued runs,
baseline deltas, lifecycle webhooks, cancellation, scheduled runs via
[triggers](./triggers.md), and the `dataset` / `dataset_item` / `eval`
[formation](./formations.md) resource types are all shipped.

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
| `expected_output` | string | Reference answer for `exact_match` and `llm_judge`; may be `null` |
| `metadata` | object | Free-form tags (e.g. `{"topic": "billing"}`), opaque to the platform and readable from `json_logic` scorers |
| `source_generation_id` | string | Reserved for server-side curation from a generation, which was [dropped](#what-is-not-here-yet); always `null` today. Record provenance for client-curated items in `metadata` |
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
| `trigger_id` | string | The [trigger](./triggers.md) that started this run, or `null` for a run started through the API. Kept even after that trigger is deleted |
| `aggregate_scores` | object | Per-scorer `mean` / `pass_rate`, the run `pass_rate`, `scored_item_count`, and — when the run named a baseline — a `baseline` [comparison](#baseline-deltas). `null` until the run is terminal, and on a canceled run |
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
| `scores` | array | `[{ scorer, score, passed, reasoning? }]`, one entry per scorer in the order the eval declares them. `reasoning` is present for `llm_judge` only |
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
| `llm_judge` | `prompt`, `pass_threshold`, `ai_provider_id` (optional), `model` (optional) | The judge's 0–1 score; see [LLM judge](#llm-judge) |

A scorer reads the generation's two output channels explicitly. `exact_match`, `contains`
and `llm_judge` read the final **text**; `output_schema` validates the **structured object**
the platform already parsed, and never re-parses the text.

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

### LLM judge

An `llm_judge` scorer grades the output with a model completion. It is just a completion: it
resolves its model through the ordinary [AI providers](./ai-providers.md) path — the scorer's
`ai_provider_id` must belong to the eval's project, and the project's default
[model route](./model-routes.md) applies when the scorer pins none — so it traces and meters
like any other call. It runs **tool-less**, so a judged output cannot trigger side effects.

The `prompt` carries three slots:

| Slot | Filled with |
| --- | --- |
| `{{input}}` | The item's input messages (JSON when not a plain string) |
| `{{output}}` | The agent's final output text |
| `{{expected}}` | The item's `expected_output`, or empty when it has none |

Slots are filled in **one pass**. A slot value that itself contains `{{output}}` is never
re-expanded — a judged output is untrusted text, and re-scanning it would let an agent's own
answer rewrite the prompt that grades it. An unrecognised `{{…}}` is left as written rather
than blanked, so a typo is visible.

The judge must answer with a JSON object carrying a numeric `score` between 0 and 1 and an
optional `reasoning` string. Prose or a code fence around it is tolerated (the first `{…}`
span is parsed); the contract itself is not. A reply that is not a JSON object, a non-numeric
score, or a score outside 0–1 marks the **item** errored — never the run failed, and never a
score of 0 (see [Errors are not zeros](#errors-are-not-zeros)). An out-of-range score is
rejected rather than clamped: a judge answering `87` out of 100 is a broken prompt, and
clamping it to 1 would report a suspiciously perfect run.

`pass_threshold` is **required** on the scorer, with no default. A judge emits a continuous
score, so nothing about the score itself says where "good enough" is, and a defaulted cutoff
would silently decide the gate every run-level verdict is computed from. The item passes the
scorer when `score >= pass_threshold`.

`reasoning` is stored on the result for audit. Judges drift with model updates, so the judge
model is pinned per scorer config — but deltas between runs judged by **different** models are
not comparable; re-run the baseline when the judge changes.

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

The pin is also what an [eval-gated promotion](./agents.md#eval-gated-promotion) matches on:
a release naming this eval as its `promotion_gate` promotes only once a run of it finished
`completed` with `passed: true` **and** carried the canary's `agent_version`. A green run
against another version is not evidence about the canary and does not open the gate.

### Pass semantics

Three levels, each derived from the one below:

1. **Per scorer, per item** — a binary scorer passes when its score is 1; an `llm_judge`
   scorer passes when its score is at least the scorer's own `pass_threshold`.
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

The same rule covers a scorer that could not reach a verdict — an `llm_judge` call failing,
or answering something unparseable. The agent's answer was never graded, so recording 0 would
fabricate a regression. The generation stays linked on the result either way: it happened,
and it cost money.

### Synchronous and queued runs

`wait` selects how a run executes. Both modes share **one** execution and finalize path, so a
`wait: true` run and a `wait: false` run of the same eval are directly comparable.

| `wait` | Behavior |
| --- | --- |
| `true` | Executes items sequentially in-process and returns the run **terminal**, with its scores. Capped at **25 items**. |
| `false` (default) | Enqueues one task per item and returns immediately with `status: "queued"`. No item cap. |

An **empty** dataset is rejected in both modes: a run that measured nothing must not produce
a verdict. A `wait: true` run over more than 25 items is rejected with `400` naming the cap
rather than scored partially — a subset reported as the run's verdict would read as a
complete pass/fail over the whole dataset. The cap is a property of synchronous execution
only; that is what `wait: false` is for.

#### How a queued run progresses

Each item becomes one queued task. A worker claims tasks in batches, executes each item, and
writes its result; the worker that drains the run's **last** task settles the run and fires
[`eval_run.completed`](#lifecycle-webhooks). Poll `GET /evals/{eval_id}/runs/{eval_run_id}`, or
subscribe to the webhook, to learn the verdict.

Delivery is **at-least-once**, and that is safe without extra bookkeeping: a result row is
unique per `(run, item)`, so a redelivered task re-runs the item into the same row instead of
double-counting it. Settling is guarded by an atomic claim, so several workers finishing at
the same instant still fire the completion event exactly once — a promotion gate that
received the same verdict twice could act twice.

The batch size bounds concurrent provider calls, and therefore the spend rate, not just rows.

#### Recovering a run left mid-flight

A background reaper settles non-terminal runs that have no outstanding work and have gone
quiet past a grace period (30 minutes by default). Two shapes get opposite treatment:

- **Every item has a result but the run never settled** — a finalize that crashed between
  the last write and the update. The measurements are all there, so the run is **finalized**.
- **Items are missing** — an abandoned `wait: true` run whose client disconnected, or work
  that was dropped. Nothing will ever complete it, so it is settled `failed` and
  `eval_run.failed` fires, because a gate waiting on a verdict must not wait forever.

A run that still has queued tasks is left alone; the worker owns it.

### Canceling a run

`POST /evals/{eval_id}/runs/{eval_run_id}/cancel` drops a queued or running run's outstanding
tasks — so it stops consuming provider budget on the next tick — and settles it `canceled`.
A run that has already finished is rejected with `400`.

Results already written are **kept**: they are real measurements of generations that were
really paid for, and `completed_count` / `errored_count` report what ran. `aggregate_scores`
is deliberately left `null`, for the same reason the synchronous cap exists — a partial
roll-up in the field a completed run uses would read as a whole-dataset verdict. A canceled
run fires no lifecycle event: it produced no verdict.

### Scheduled runs

A [trigger](./triggers.md) with `target_type: "eval"` runs a suite on a cadence — the
nightly regression an author never has to remember to start. Every starter works (manual,
webhook, and cron `schedule`), and the firing always starts a **queued** run: a suite is one
real agent generation per dataset item, so blocking a scheduler tick on it is exactly the
case [sync vs async](../advanced/sync-and-async.md) rules out. The firing's
`result.result_id` is the `evrun_…` to poll.

The run records its origin in `trigger_id`, and keeps it if that trigger is later deleted —
a run is a historical measurement, so nothing after the fact rewrites where it came from.
Filter a run list by it to separate scheduled regressions from ad-hoc runs.

The trigger's `input` may carry `agent_version` and `baseline_run_id`, which are passed to
each run it starts; both are validated at fire time, so a nightly schedule naming a version
that no longer exists fails the **firing** (with the reason on the firing record) instead of
creating a run that could never execute.

Creating an eval-target trigger requires `evaluations:RunEval` on top of
`triggers:CreateTrigger`: a trigger can only start what its creator could start directly.

```bash
soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name nightly-regression \
  --type schedule \
  --target-type eval \
  --target-id "$EVAL_ID" \
  --cron "0 3 * * *"
```

### Formation support

Datasets, their items, and evals are declarable in a [Formation](./formations.md) template,
so a suite ships with the agent it verifies:

| Resource type | Properties |
| --- | --- |
| `dataset` | `name`, `description` |
| `dataset_item` | `dataset_id`, `input`, `expected_output`, `metadata` |
| `eval` | `name`, `agent_id`, `dataset_id`, `scorers`, `pass_threshold` |

Test cases are their own resource rather than a list inside the dataset — the
[memory / memory entry](./memories.md) shape — so an item curated through the API is never
collateral of a formation apply, and each declared case has its own physical id.

```yaml
resources:
  Suite:
    type: dataset
    properties:
      name: billing-questions
  RefundCase:
    type: dataset_item
    properties:
      dataset_id: { ref: Suite }
      input:
        - role: user
          content: How do I get a refund?
      expected_output: Open a refund request from the order page.
  Regression:
    type: eval
    properties:
      name: billing-regression
      agent_id: { ref: SupportAgent }
      dataset_id: { ref: Suite }
      scorers:
        - type: contains
          value: refund
      pass_threshold: 0.8
  Nightly:
    type: trigger
    properties:
      name: nightly-billing-regression
      type: schedule
      target_type: eval
      target_id: { ref: Regression }
      cron: 0 3 * * *
```

Changing `pass_threshold` (or the scorers, agent, or dataset) updates the eval in place;
removing the resource from the template deletes it. `dataset_id` is immutable on a
`dataset_item` — a template that moves an item to another dataset is rejected rather than
silently applying the rest.

### Baseline deltas

Pass `baseline_run_id` (a terminal run of the **same** eval; a run of another eval is a
`400`) and the finished run's `aggregate_scores.baseline` reports how it moved:

| Field | Meaning |
| --- | --- |
| `run_id` | The baseline compared against |
| `compared_item_count` | Items present and scorable in **both** runs — the basis of every delta |
| `added_item_count` | Scorable here but not in the baseline (added since, or errored there) |
| `removed_item_count` | Scorable in the baseline but not here (removed since, or errored here) |
| `pass_rate_delta` | Run-level pass-rate delta over the intersection; `null` when the two runs share no comparable item |
| `scorers` | Per scorer type, `mean_delta` and `pass_rate_delta` |

Positive deltas mean this run scored **higher** than the baseline.

Every number is computed over the **item intersection**, recomputing both sides rather than
subtracting the two runs' stored aggregates. Items have full CRUD and a run may error on an
item the baseline scored, so comparing stored aggregates would quietly attribute **dataset
drift to the agent** — the fabricated regression this module exists to prevent. Divergence is
reported through the counts instead of being averaged in, and a scorer that only one of the
two runs ran is omitted rather than compared against nothing.

### Lifecycle webhooks

Two [webhook](./webhooks.md) events carry a run's outcome:

| Event | Fires when |
| --- | --- |
| `eval_run.completed` | A run reached a terminal status with its items scored |
| `eval_run.failed` | A run could not be executed to completion |

Both carry `{ eval_id, eval_run_id, passed, aggregate_scores }`. The verdict and the
aggregates are inline rather than only an id to fetch: this event **is** the promotion gate,
and a gate that has to make a second call to learn its answer is a gate that can fail open
when that call does. Exactly one event fires per terminal run, from the single finalize path
both run modes share.

### Eval spend is separable from production spend

Every item is a real generation, and `llm_judge` doubles the calls — so eval
[usage](./usage.md) is labelled at the metering choke point:

| `source` | What it paid for |
| --- | --- |
| `eval` | An eval run's item generations |
| `eval_judge` | An `llm_judge` scorer's own completion |

Verification spend is therefore `source IN ('eval','eval_judge')`, and the two labels are
distinct so a rollup can price *running* a suite apart from *grading* it. Ordinary agent
traffic carries no `source`. A run also inherits the platform's ordinary cost controls —
[quotas](./quotas.md) and usage thresholds still apply — but a very large dataset is a
footgun until per-run item limits are tuned.

:::warning[Eval runs have real side effects]

A run creates real generations, so an agent with a write-capable `http` or `mcp`
[tool](./tools.md) performs N real writes per run. There is no tool-stub mode, deliberately:
running the real agent is the premise that makes a score mean anything. Point an eval'd
agent's tools at a staging target.

:::

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

Run it synchronously and read the per-item results:

```bash
soat start-eval-run --eval_id "$EVAL_ID" --wait true
soat list-eval-results --eval_id "$EVAL_ID" --eval_run_id "$RUN_ID"
```

Queue a larger run and poll for the verdict:

```bash
soat start-eval-run --eval_id "$EVAL_ID" --wait false   # → status: queued
soat get-eval-run --eval_id "$EVAL_ID" --eval_run_id "$RUN_ID"
soat cancel-eval-run --eval_id "$EVAL_ID" --eval_run_id "$RUN_ID"
```

Add an LLM judge alongside a deterministic scorer:

```bash
soat create-eval --project_id "$PROJECT_ID" --name billing-judged-suite \
  --agent_id "$AGENT_ID" --dataset_id "$DATASET_ID" \
  --scorers '[
    {"type":"contains","value":"invoice"},
    {"type":"llm_judge",
     "ai_provider_id":"'"$PROVIDER_ID"'",
     "prompt":"Rate 0-1 how well the answer matches the reference. Answer with {\"score\": <0-1>, \"reasoning\": \"<why>\"}. Question: {{input}} Answer: {{output}} Reference: {{expected}}",
     "pass_threshold":0.7}
  ]' \
  --pass_threshold 0.8
```

Evaluate a specific archived version against a baseline — the shape a promotion gate uses:

```bash
soat start-eval-run --eval_id "$EVAL_ID" --wait true \
  --agent_version 3 --baseline_run_id "$BASELINE_RUN_ID"
```

Gate a canary rollout on this eval, then produce the run that opens the gate:

```bash
soat set-agent-release --agent-id "$AGENT_ID" \
  --stable-version 2 --canary-version 3 --canary-percent 20 \
  --promotion-gate "$EVAL_ID"
soat start-eval-run --eval_id "$EVAL_ID" --wait true --agent_version 3
soat promote-agent-release --agent-id "$AGENT_ID"
```

## What is not here yet

- **`from-generation` curation** — a server-side route that builds a dataset item from a
  past generation. This was considered and **dropped**: the generation's input messages and
  output text are not persisted in any platform-owned shape (they exist only inside the
  provider-shaped step blob on the [trace](./traces.md)'s file), and persisting a second
  copy of end-user prompts is a privacy cost the feature has not yet earned. To build a
  dataset from real traffic, curate client-side — fetch the content at your own boundary
  and `POST` it through the ordinary item-create route, optionally recording provenance in
  the item's `metadata`.

Sequencing lives in
[`docs/roadmap.md`](https://github.com/ttoss/soat/blob/main/docs/roadmap.md).
