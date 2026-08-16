---
description: "Evaluations — datasets, scorers, and scored runs that turn 'did this change make the agent better?' into a pass/fail verdict in SOAT."
---

# Evaluations

Repeatable, scored test suites for an agent: a dataset of cases, scorers that grade the
output, and runs that produce a pass/fail verdict.

## Overview

A **dataset** holds test cases, an **eval** binds an agent to a dataset and a list of
**scorers**, and a **run** executes the real agent against every case and scores the
outputs. Where [traces](./traces.md) and [guardrails](./guardrails.md) deal with runs that
already happened or are happening, an evaluation answers whether a *change* to the agent —
a reworded instruction, a swapped model, a new tool — improved the distribution of runs.
Evaluations is the foundation of the ratchet layer described in
[The Layers of an Agent System](../getting-started/agent-system-layers.md#layer-4--the-ratchet).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Evaluate an Agent - Step 3 (Build a dataset)](/docs/tutorials/evaluate-an-agent#step-3--build-a-dataset)
- [Evaluate an Agent - Step 6 (Measure a prompt change against a baseline)](/docs/tutorials/evaluate-an-agent#step-6--fix-the-prompt-then-measure-the-fix)
- [Judge Open-Ended Answers - Step 3 (Bind an llm_judge scorer)](/docs/tutorials/judge-open-ended-answers#step-3--bind-the-judge)
- [Judge Open-Ended Answers - Step 5 (Run queued and poll)](/docs/tutorials/judge-open-ended-answers#step-5--run-it-queued-instead-of-blocking)
- [Gate a Canary Promotion on an Eval - Step 4 (Set a promotion gate)](/docs/tutorials/gate-a-canary-promotion-on-an-eval#step-4--start-a-gated-canary-release)
- [Gate a Canary Promotion on an Eval - Step 8 (Schedule nightly runs)](/docs/tutorials/gate-a-canary-promotion-on-an-eval#step-8--keep-feeding-the-gate-after-you-stop-watching)

## Data Model

### Dataset

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `dset_…`) |
| `project_id` | string | ID of the owning project |
| `name` | string | Unique within the project |
| `description` | string | Optional free text |
| `created_at` / `updated_at` | string | ISO 8601 timestamps |

Deleting a dataset deletes its items **and** the evals bound to it.

### Dataset item

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `dsit_…`) |
| `dataset_id` | string | ID of the owning dataset |
| `input` | array | `{ role, content }` messages, replayed verbatim as the generation's input |
| `expected_output` | string | Reference answer for `exact_match` and `llm_judge`; may be `null` |
| `metadata` | object | Free-form tags (e.g. `{"topic": "billing"}`), opaque to the platform and readable from `json_logic` scorers |
| `source_generation_id` | string | The generation this item was curated from (see [Curating items from production](#curating-items-from-production)); `null` for a hand-authored item, and `null` again once that generation is deleted |
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

An `agent_id` or `dataset_id` naming a resource in another project is rejected with `400`.

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
| `passed` | boolean | The verdict; `null` when the eval declares no `pass_threshold`, and on a canceled run |
| `item_count` / `completed_count` / `errored_count` | integer | Items attempted, scored, and errored. On a [canceled](#canceling-a-run) run the last two count what actually ran |
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
| `output` | string | The agent's final output text. `null` only when there is none — the generation failed or never completed — or once the linked generation's content is [purged](#retention-and-erasure). An item errored by a **scorer** keeps the output it was graded on |
| `scores` | array | `[{ scorer, score, passed, reasoning? }]`, one entry per scorer in the order the eval declares them. `reasoning` is present for `llm_judge` only |
| `passed` | boolean | AND over the per-scorer `passed` flags |
| `error` | string | Item-level failure reason; set instead of scoring, never alongside it |
| `created_at` | string | ISO 8601 creation timestamp |

## Key Concepts

### Scorers

`scorers` is a discriminated union on `type`. Each type may appear **at most once** per
eval (aggregate scores are keyed by type). Every scorer produces
`{ score: 0–1, passed: boolean }` — binary scorers emit 0 or 1.

| `type` | Config | Scores |
| --- | --- | --- |
| `exact_match` | — | 1 when the trimmed output text equals `expected_output`; an item with no reference answer cannot pass |
| `contains` | `value`, `case_sensitive` (default `false`) | 1 when `value` occurs in the output text |
| `json_logic` | `expression` | 1 when the [JSON Logic](https://jsonlogic.com) expression evaluates truthy |
| `output_schema` | `schema` (optional) | 1 when the structured output validates against the schema |
| `llm_judge` | `prompt`, `pass_threshold`, `ai_provider_id` (optional), `model` (optional) | The judge's 0–1 score; see [LLM judge](#llm-judge) |

`exact_match`, `contains` and `llm_judge` read the final **text**; `output_schema`
validates the **structured object** the platform already parsed. `json_logic` sees both,
through these variables:

| Var | Value |
| --- | --- |
| `input` | The item's input messages |
| `output` | The final output text |
| `object` | The structured output. **Absent** when the agent has no `output_schema` — an expression over it evaluates falsy rather than erroring |
| `expected` | The item's `expected_output` |
| `item.metadata` | The item's metadata bag |

An `output_schema` scorer is rejected with `400` unless the **agent under test** carries an
`output_schema` — even when the scorer supplies its own `schema` — because the platform only
produces structured output when the agent's schema constrains the model. The check runs at
eval-create (best-effort) and again at run start (authoritative).

### LLM judge

An `llm_judge` scorer grades the output with a tool-less model completion, resolved through
the ordinary [AI providers](./ai-providers.md) path (the scorer's `ai_provider_id` must
belong to the eval's project; the project's default [model route](./model-routes.md) applies
when the scorer pins none). The `prompt` carries three slots, filled in **one pass** (a slot
value containing `{{output}}` is never re-expanded; an unrecognised `{{…}}` is left as
written):

| Slot | Filled with |
| --- | --- |
| `{{input}}` | The item's input messages (JSON when not a plain string) |
| `{{output}}` | The agent's final output text |
| `{{expected}}` | The item's `expected_output`, or empty when it has none |

The judge must answer with a JSON object carrying a numeric `score` between 0 and 1 and an
optional `reasoning` string (stored on the result). Prose or a code fence around it is
tolerated (the first `{…}` span is parsed). A non-JSON reply, non-numeric score, or score
outside 0–1 marks the **item** errored — never the run failed, and never a score of 0.

`pass_threshold` is **required** on the scorer, with no default; the item passes when
`score >= pass_threshold`. Judges drift with model updates — re-run the baseline when the
judge model changes.

### Frozen inputs

Each result carries its own copy of the item's `input` and `expected_output`, taken at run
time, so editing or deleting an item between two runs cannot make their scores
incomparable. Deleting an item nulls `dataset_item_id` on past results and changes nothing
else.

### Curating items from production

A hand-authored dataset drifts away from the traffic it is supposed to represent, which is
the traffic a canary actually has to survive. `create-dataset-item-from-generation`
promotes a real turn instead:

```bash
soat create-dataset-item-from-generation \
  --dataset-id "$DATASET_ID" \
  --generation-id "$GENERATION_ID"
```

The generation's stored input messages become the item's `input`, and its own answer
becomes `expected_output` — pass `--expected-output` to override it, or `null` to store the
item with no reference answer. `source_generation_id` records where the item came from.

What the item stores is a **copy**, not a view. It keeps working after the source
generation's content is purged, and if that generation is deleted `source_generation_id`
simply goes null — consistent with the rest of the module, where a purge can never quietly
stop a suite from being runnable.

Two rules bound what can be promoted:

- **Only a completed generation.** A paused (`requires_action`) or failed turn has no
  finished answer, so it is refused with `409 GENERATION_NOT_COMPLETED` rather than turned
  into a fixture that scores whatever the agent does next.
- **Only while its content is available.** Replay needs the input that
  [content retention](#retention-and-erasure) exists to withhold, so an agent or project
  running with `trace_content_mode: none` never stored it, and a purged or expired
  generation no longer has it. Both answer `409 GENERATION_CONTENT_UNAVAILABLE`, as do
  generations produced before input recording existed.

The call copies content out of a generation, so it requires `generations:GetGeneration` in
addition to `evaluations:CreateDataset`. The generation must also belong to the same
project as the dataset.

### Version pinning

A run resolves **one** agent version at run start, stamps it on `agent_version`, and every
item executes against it.

- Pass `agent_version` to name an archived [version](./agents.md#versioning-and-staged-rollout).
  An unknown version is a `400`.
- Omit it and the run uses the [active release's](./agents.md#staged-rollout) **stable**
  version, or the live draft version when no release is in effect.

An [eval-gated promotion](./agents.md#eval-gated-promotion) matches on the pin: a release
naming this eval as its `promotion_gate` promotes only once a run finished `completed` with
`passed: true` **and** carried the canary's `agent_version`.

### Pass semantics

1. **Per scorer, per item** — a binary scorer passes when its score is 1; an `llm_judge`
   scorer passes when its score is at least the scorer's own `pass_threshold`.
2. **Per item** — `EvalResult.passed` is the AND over its per-scorer flags.
3. **Per run** — `EvalRun.passed` is `null` when the eval has no `pass_threshold`;
   otherwise it is true when the **pass rate** — passed items over non-errored items — is
   at least the threshold.

The verdict gates on the pass rate, never on a pooled mean. `aggregate_scores` still
reports per-scorer means. A run that scored nothing at all does not pass.

### Errors are not zeros

An item whose generation did not complete — e.g. an agent with client-side tools pausing
for tool outputs (`requires_action`) — is recorded as an **error**, excluded from
`aggregate_scores`, and counted in `errored_count`; it is never scored 0. The same rule
covers a scorer that could not reach a verdict (an `llm_judge` call failing or answering
something unparseable). When the **generation** produced nothing, `output` is `null`; when
a **scorer** failed over a good generation, the result keeps that generation's `output`
alongside the `error`. The generation stays linked either way.

### Synchronous and queued runs

`wait` selects how a run executes (see [sync vs async](../advanced/sync-and-async.md) for
the platform-wide contract). Both modes share one execution and finalize path.

| `wait` | Behavior |
| --- | --- |
| `true` | Executes items sequentially in-process and returns the run **terminal**, with its scores. Capped at **25 items** — a larger dataset is rejected with `400`. |
| `false` (default) | Enqueues one task per item and returns immediately with `status: "queued"`. No item cap. |

An **empty** dataset is rejected in both modes: a run that measured nothing must not
produce a verdict.

For a queued run, a worker claims tasks in batches; the worker that drains the run's
**last** task settles the run and fires [`eval_run.completed`](#lifecycle-webhooks). Poll
[`GET /evals/{eval_id}/runs/{eval_run_id}`](/docs/api/evaluations/get-eval-run) or subscribe to the webhook. Delivery is
at-least-once but safe: a result row is unique per `(run, item)`, and settling is guarded
by an atomic claim, so the completion event fires exactly once.

A background reaper settles non-terminal runs that have gone quiet past a grace period
(30 minutes by default): a run whose items all have results is finalized; a run with items
missing and no outstanding work is settled `failed` and `eval_run.failed` fires. A run
that still has queued tasks is left alone.

### Canceling a run

[`POST /evals/{eval_id}/runs/{eval_run_id}/cancel`](/docs/api/evaluations/cancel-eval-run) drops a queued or running run's
outstanding tasks and settles it `canceled`; a run that has already finished is rejected
with `400`. Results already written are **kept**, and `completed_count` /
`errored_count` report what ran — an item a worker had already claimed runs to completion
and recounts the run after it settles. `aggregate_scores` is deliberately left `null` (a
partial roll-up would read as a whole-dataset verdict), and no lifecycle event fires.

### Scheduled runs

A [trigger](./triggers.md) with `target_type: "eval"` runs a suite on a cadence. Every
starter works (manual, webhook, and cron `schedule`), and the firing always starts a
**queued** run; the firing's `result.result_id` is the `evrun_…` to poll. The run records
its origin in `trigger_id` and keeps it if the trigger is later deleted.

The trigger's `input` may carry `agent_version` and `baseline_run_id`; both are validated
at fire time, so a nightly schedule naming a version that no longer exists fails the
**firing** (with the reason on the firing record) instead of creating a run that could
never execute. Creating an eval-target trigger requires `evaluations:RunEval` on top of
`triggers:CreateTrigger`.

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

Datasets, their items, and evals are declarable in a [Formation](./formations.md) template:

| Resource type | Properties |
| --- | --- |
| `dataset` | `name`, `description` |
| `dataset_item` | `dataset_id`, `input`, `expected_output`, `metadata` |
| `eval` | `name`, `agent_id`, `dataset_id`, `scorers`, `pass_threshold` |

Items are their own resource, so an item curated through the API is never collateral of a
formation apply. `dataset_id` is immutable on a `dataset_item` — a template that moves an
item to another dataset is rejected. Running the suite gives the agent under test
generation history, so deleting the formation later fails with
`409 FORMATION_DELETE_FAILED` naming that agent — see
[formation teardown](./formations.md#resource-lifecycle); force-delete the agent
([`DELETE /api/v1/agents/{agent_id}?force=true`](/docs/api/agents/delete-agent)) or declare it with
`deletion_policy: retain`.

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

Positive deltas mean this run scored **higher** than the baseline. Every number is
computed over the **item intersection**, recomputing both sides, so dataset drift is
reported through the counts instead of being attributed to the agent. A scorer that only
one of the two runs ran is omitted.

### Lifecycle webhooks

Two [webhook](./webhooks.md) events carry a run's outcome:

| Event | Fires when |
| --- | --- |
| `eval_run.completed` | A run reached a terminal status with its items scored |
| `eval_run.failed` | A run could not be executed to completion |

Both carry `{ eval_id, eval_run_id, passed, aggregate_scores }` inline — this event is the
promotion gate, so the verdict must not require a second call. Exactly one event fires per
terminal run.

### Eval spend is separable from production spend

Every item is a real generation, and `llm_judge` doubles the calls. Eval spend is labelled
in [usage](./usage.md) metering: item generations carry `source: "eval"` and judge
completions `source: "eval_judge"` (ordinary agent traffic carries no `source`). Filter
with [`GET /api/v1/usage/meters?source=eval`](/docs/api/usage/list-usage-meters) or roll up with
[`GET /api/v1/usage?group_by=source`](/docs/api/usage/get-usage). [Quotas](./quotas.md) and usage thresholds still
apply to eval runs.

:::warning[Eval runs have real side effects]

A run creates real generations, so an agent with a write-capable `http` or `mcp`
[tool](./tools.md) performs N real writes per run. There is no tool-stub mode. Point an
eval'd agent's tools at a staging target.

:::

### Retention and erasure

`EvalResult.output` is a copy of a generation's content, so purging that generation's
content — directly, or through its trace — also clears the copy. Scores, `passed`, and the
frozen `input` / `expected_output` survive. Datasets are operator-owned test fixtures: a
content purge never deletes or mutates a dataset item — an erasure covering curated
content requires deleting the item explicitly. That applies to items curated with
[`create-dataset-item-from-generation`](#curating-items-from-production) too: promoting a
turn copies its content into a fixture that outlives the source, which is what keeps a
suite runnable, and also what makes deleting the item the only way to erase it.

## Examples

Create a dataset and add a case:

```bash
soat create-dataset --project-id "$PROJECT_ID" --name billing-regressions

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"When is my invoice issued?"}]' \
  --expected-output "On the first of each month." \
  --metadata '{"topic":"billing"}'
```

Bind an eval and gate it at an 80% pass rate:

```bash
soat create-eval --project-id "$PROJECT_ID" --name billing-regression-suite \
  --agent-id "$AGENT_ID" --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"contains","value":"first of each month"}]' \
  --pass-threshold 0.8
```

Run it synchronously and read the per-item results:

```bash
soat start-eval-run --eval-id "$EVAL_ID" --wait true
soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID"
```

Queue a larger run and poll for the verdict:

```bash
soat start-eval-run --eval-id "$EVAL_ID" --wait false   # → status: queued
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID"
soat cancel-eval-run --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID"
```

Evaluate a specific archived version against a baseline — the shape a promotion gate uses:

```bash
soat start-eval-run --eval-id "$EVAL_ID" --wait true \
  --agent-version 3 --baseline-run-id "$BASELINE_RUN_ID"
```
