---
description: "Evaluations — datasets, scorers, and scored runs that turn 'did this change make the agent better?' into a pass/fail verdict in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Evaluations

Repeatable, scored test suites for an agent: a dataset of cases, scorers that grade the
output, and runs that produce a pass/fail verdict.

## Overview

A **dataset** holds test cases, an **eval** binds an agent to a dataset and a list of
**scorers**, and a **run** executes the real agent against every case and scores the
outputs. Where [traces](./traces.md) and [guardrails](./guardrails.md) deal with individual
runs, an evaluation answers whether a change to the agent improved the distribution of
runs. It is the ratchet layer of
[The Layers of an Agent System](../agent-system-layers.md#layer-4--the-ratchet).
How to choose the items, scorers and threshold so the verdict means something:
[Eval Design](../advanced/eval-design.md).

The module follows the [engine & algorithms pattern](../advanced/engines-and-algorithms.md):
the **engine** runs items, freezes inputs, aggregates and settles; the **scorers** are the
algorithm layer, including [custom scorers](#custom-scorers-tool) implemented as a
[tool](./tools.md). See [the boundary section](#the-engine-and-the-scorers).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Evaluate an Agent - Step 3 (Build a dataset)](/docs/tutorials/evaluate-an-agent#step-3--build-a-dataset)
- [Evaluate an Agent - Step 6 (Measure a prompt change against a baseline)](/docs/tutorials/evaluate-an-agent#step-6--fix-the-prompt-then-measure-the-fix)
- [Judge Open-Ended Answers - Step 3 (Bind an llm_judge scorer)](/docs/tutorials/judge-open-ended-answers#step-3--bind-the-judge)
- [Judge Open-Ended Answers - Step 5 (Check the judge against your own grades)](/docs/tutorials/judge-open-ended-answers#step-5--check-the-judge-against-your-own-grades)
- [Judge Open-Ended Answers - Step 6 (Run queued and poll)](/docs/tutorials/judge-open-ended-answers#step-6--run-it-queued-instead-of-blocking)
- [Grade Structured Output with Your Own Scorer - Step 6 (Bind output_schema, json_logic and tool scorers)](/docs/tutorials/grade-structured-output-with-your-own-scorer#step-6--bind-three-scorers)
- [Grade an Eval with a Decider - Step 8 (Bind a decider scorer)](/docs/tutorials/grade-an-eval-with-a-decider#step-8--bind-the-decider-as-a-scorer-and-run)
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
| `metadata` | object | Annotations on the item (e.g. `{"topic": "billing"}`), stored as written and readable from a `json_logic` scorer — see [Tags and metadata](iam.md#tags-and-metadata) |
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
| `group_by` | string | A key of the items' `metadata` a run rolls its scores up by, or `null`; see [Grouped aggregates](#grouped-aggregates) |
| `created_at` / `updated_at` | string | ISO 8601 timestamps |

An `agent_id` or `dataset_id` naming a resource in another project is rejected with `400`.

### Eval run

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier (e.g. `evrun_…`) |
| `eval_id` | string | ID of the eval this run belongs to |
| `agent_version` | integer | The one agent version every item ran against; see [Version pinning](#version-pinning) |
| `decider_versions` | object \| null | Scorer name → the decider version each [`decider` scorer](#decider-scorers-decider) grades under, resolved when the run started; `null` when the eval has none |
| `status` | string | `queued` \| `running` \| `completed` \| `failed` \| `canceled` |
| `baseline_run_id` | string | A terminal run of the same eval, or `null` |
| `trigger_id` | string | The [trigger](./triggers.md) that started this run, or `null` for a run started through the API. Kept even after that trigger is deleted |
| `aggregate_scores` | object | Per-scorer `mean` / `pass_rate`, the run `pass_rate` and its [`pass_rate_interval`](#uncertainty), `scored_item_count`, a `grouping` per value of the eval's [`group_by`](#grouped-aggregates) key, and — when the run named a baseline — a `baseline` [comparison](#baseline-deltas). `null` until the run is terminal, and on a canceled run |
| `passed` | boolean | The verdict; `null` when the eval declares no `pass_threshold`, and on a canceled run |
| `item_count` / `completed_count` / `errored_count` | integer | Items attempted, scored, and errored. On a [canceled](#canceling-a-run) run the last two count what actually ran |
| `metadata` | object \| null | Caller-owned annotations supplied when the run was started (see [Run metadata](#run-metadata) and [Tags and metadata](iam.md#tags-and-metadata)) |
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
| `scores` | array | `[{ scorer, score, passed, reasoning?, decision_id? }]`, one entry per scorer in the order the eval declares them. `scorer` is the type — or the scorer's `name` for a [`tool`](#custom-scorers-tool) or [`decider`](#decider-scorers-decider) scorer. `reasoning` is present for `llm_judge`, and for `tool` scorers whose tool returned one; `decision_id` for `decider` scorers |
| `passed` | boolean | AND over the per-scorer `passed` flags |
| `error` | string | Item-level failure reason; set instead of scoring, never alongside it |
| `created_at` | string | ISO 8601 creation timestamp |

## Key Concepts

### The engine and the scorers

| Layer | What it covers here | Where it is documented |
| --- | --- | --- |
| **The engine** — mechanics, not configurable, no opinions | Executing every item against the real agent, [freezing inputs](#frozen-inputs), [version pinning](#version-pinning), [pass semantics](#pass-semantics) and aggregation, [error handling](#errors-are-not-zeros), [sync/queued execution](#synchronous-and-queued-runs), [cancelation](#canceling-a-run), [scheduling](#scheduled-runs), [baseline deltas](#baseline-deltas), [webhooks](#lifecycle-webhooks), [metering](#eval-spend-is-separable-from-production-spend), [retention](#retention-and-erasure) | The sections named at left |
| **The algorithms** — opinionated, swappable | The [scorers](#scorers): what "good output" means for an item | [Scorers](#scorers), [LLM judge](#llm-judge) |
| **Bring your own** | A scorer whose grading logic is your code | [Custom scorers](#custom-scorers-tool) |

The engine's guarantees hold identically for built-in and custom scorers.

### Scorers

`scorers` is a discriminated union on `type`. Every scorer produces
`{ score: 0–1, passed: boolean }` (binary scorers emit 0 or 1), so aggregation, thresholds
and baseline deltas are scorer-agnostic. Each built-in type may appear **at most once** per
eval; `tool` and `decider` scorers may appear several times, each under a distinct `name`
(outcomes and aggregate scores key on the type, or on the `name` for those two).

| `type` | Config | Scores |
| --- | --- | --- |
| `exact_match` | — | 1 when the trimmed output text equals `expected_output`; an item with no reference answer cannot pass |
| `contains` | `value`, `case_sensitive` (default `false`) | 1 when `value` occurs in the output text |
| `json_logic` | `expression` | 1 when the [JSON Logic](https://jsonlogic.com) expression evaluates truthy |
| `output_schema` | `schema` (optional) | 1 when the structured output validates against the schema |
| `embedding_similarity` | `pass_threshold` | The cosine similarity between the embeddings of the output text and `expected_output`, clamped to 0–1; see [Embedding similarity](#embedding-similarity) |
| `llm_judge` | `prompt`, `pass_threshold`, `ai_provider_id` (optional), `model` (optional) | The judge's 0–1 score; see [LLM judge](#llm-judge) |
| `tool` | `name`, `tool_id`, `action` (builtin/mcp tools), `preset_parameters` (optional), `pass_threshold` (optional) | Whatever your algorithm answers; see [Custom scorers](#custom-scorers-tool) |
| `decider` | `name`, `decider_id`, `score`, `pass_threshold`, `input` (optional) | `score` evaluated over the answers of a [decision](./deciders.md); see [Decider scorers](#decider-scorers-decider) |

`exact_match`, `contains`, `embedding_similarity` and `llm_judge` read the final **text**;
`output_schema` validates the **structured object** the platform parsed. `json_logic` sees
both, through these variables:

| Var | Value |
| --- | --- |
| `input` | The item's input messages |
| `output` | The final output text |
| `object` | The structured output. **Absent** when the agent has no `output_schema` — an expression over it evaluates falsy rather than erroring |
| `expected` | The item's `expected_output` |
| `item.metadata` | The item's metadata bag |

An `output_schema` scorer is rejected with `400` unless the **agent under test** carries an
`output_schema`, even when the scorer supplies its own `schema`: structured output is only
produced when the agent's schema constrains the model. Checked at eval-create (best-effort)
and at run start (authoritative).

### Embedding similarity

An `embedding_similarity` scorer embeds the output text and the item's `expected_output`
with the platform's configured embedding model (`EMBEDDING_PROVIDER` / `EMBEDDING_MODEL`,
the stack [document ingestion](./documents.md) uses) and scores their **cosine
similarity**, clamped to 0–1. It is cheaper and more repeatable than an LLM judge while
tolerating paraphrases `exact_match` would fail.

`pass_threshold` is **required** on the scorer, with no default: the score is continuous
and its meaning differs per embedding model, so calibrate it against your own data.

- An item with **no `expected_output`** scores 0 and cannot pass (as for `exact_match`).
  The embedding backend is not called for such an item.
- An **embedding backend failure** marks the *item* errored — never the run failed, never
  a score of 0.

Scores from runs executed under different `EMBEDDING_MODEL` values are not comparable;
re-run the baseline when the embedding model changes.

### LLM judge

An `llm_judge` scorer grades the output with a tool-less model completion through the
ordinary [AI providers](./ai-providers.md) path: the scorer's `ai_provider_id` must belong
to the eval's project, and the project's default [model route](./model-routes.md) applies
when the scorer pins none. A scorer that pins none in a project with no default is refused
with `400 VALIDATION_FAILED` on eval create, update and run start, and the project's
default cannot be cleared while such an eval inherits it. The `prompt` carries three slots, filled in **one pass** (a slot
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
outside 0–1 marks the **item** errored — never the run failed, never a score of 0.

`pass_threshold` is **required** on the scorer, with no default; the item passes when
`score >= pass_threshold`. Re-run the baseline when the judge model changes.

### Custom scorers (`tool`)

The [bring-your-own-algorithm seam](../advanced/engines-and-algorithms.md): the engine
invokes a [tool](./tools.md) you own once per item; it answers with the same
`{ score, passed }` shape as every built-in scorer.

| Config field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Keys this scorer's outcomes and aggregate buckets. Unique within the eval; must not shadow a built-in type. Several `tool` scorers may coexist under distinct names |
| `tool_id` | yes | The tool that grades each item. Must belong to the eval's project and be server-callable — `http`, `mcp`, `builtin`, or `pipeline`. A `client` tool is rejected with `400`: it pauses for a calling client, and an eval run scores server-side |
| `action` | builtin/mcp only | The operation to invoke on a multi-action tool |
| `preset_parameters` | no | Fixed values merged into every call's input at the top level. The engine-injected keys below are reserved and rejected |
| `pass_threshold` | no | Fallback verdict cutoff; see below |

**Input** — the engine calls the tool with the same variables a `json_logic` expression
reads:

```jsonc
{
  "input": [{ "role": "user", "content": "Is this friendly?" }], // the item's input messages
  "output": "Absolutely, very friendly!",  // the agent's final output text
  "object": { "category": "other" },       // structured output; absent when the agent has no output_schema
  "expected": "yes",                        // the item's expected_output, or null
  "item": { "metadata": { "topic": "tone" } }
  // preset_parameters are merged in at the top level
}
```

**Output** — the tool must answer with a JSON object (an `http` target answering
`text/plain`, or an `mcp` tool's text content, is scanned for its first `{…}` span):

```jsonc
{
  "score": 0.9,               // required, 0–1
  "passed": true,             // optional — your algorithm's own verdict
  "reasoning": "Warm phrasing." // optional, stored on the result
}
```

**Verdict resolution.** A tool-returned `passed` wins; else the scorer's `pass_threshold`
applies (`score >= pass_threshold`, the same `>=` rule as `llm_judge`); when neither exists
the item is **errored**. Declare `pass_threshold` to tune the cutoff without redeploying
the tool.

**Error semantics** follow [errors are not zeros](#errors-are-not-zeros): a failed tool
call, an unparseable answer, an out-of-range score, or a missing verdict errors the
**item**, which keeps the output it was graded on; its `error` names the scorer.

**Validation** runs at eval create and update, and authoritatively at run start: a tool
deleted since fails the run request with `400`.

Bind one like any other scorer:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-eval --project-id "$PROJECT_ID" --name tone-suite \
  --agent-id "$AGENT_ID" --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"tool","name":"tone","tool_id":"'"$TOOL_ID"'","pass_threshold":0.5}]' \
  --pass-threshold 0.8
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.createEval({
  body: {
    project_id: projectId,
    name: 'tone-suite',
    agent_id: agentId,
    dataset_id: datasetId,
    scorers: [{ type: 'tool', name: 'tone', tool_id: toolId, pass_threshold: 0.5 }],
    pass_threshold: 0.8,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/evals \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "tone-suite",
    "agent_id": "'"$AGENT_ID"'",
    "dataset_id": "'"$DATASET_ID"'",
    "scorers": [{"type":"tool","name":"tone","tool_id":"'"$TOOL_ID"'","pass_threshold":0.5}],
    "pass_threshold": 0.8
  }'
```

</TabItem>
</Tabs>

Calls are real, one per item: point scorer tools at infrastructure that tolerates the
volume, and at a staging target if the algorithm has side effects.

### Decider scorers (`decider`)

A `decider` scorer grades each item with a decision of a project [decider](./deciders.md):
the questions are the decider's, versioned and shared with every other caller of it, so
the eval grades exactly what production asks the same decider.

| Config field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Keys this scorer's outcomes and aggregate buckets, as for a `tool` scorer |
| `decider_id` | yes | A decider in the eval's project; checked at eval create, update and run start |
| `score` | yes | [JSON Logic](https://jsonlogic.com) over `{ answers, answers_by_name }`, the decision's answers in question order and keyed by question `name`, yielding the item's 0–1 score |
| `pass_threshold` | yes | The item passes when `score >= pass_threshold`. No default, as on `llm_judge` |
| `input` | no | JSON Logic over the item context (`input`, `output`, `object`, `expected`, `item`) building the decision's `input`. Omitted, the input is that context itself |

A predicate's `probability` is the natural score: a tool backend returns the model's
certainty, which a bare true/false drops (an agent backend records 1 or 0). A score
answer's `score` is a level index; divide it by the top index (`tone` below has three
levels) to read it as 0–1:

```json
{
  "type": "decider",
  "name": "reply_review",
  "decider_id": "dcd_…",
  "input": { "customer": { "var": "input.0.content" }, "reply": { "var": "output" } },
  "score": {
    "*": [
      { "var": "answers_by_name.resolves_issue.probability" },
      { "-": [1, { "var": "answers_by_name.policy_violation.probability" }] },
      { "/": [{ "var": "answers_by_name.tone.score" }, 2] }
    ]
  },
  "pass_threshold": 0.7
}
```

- **Pinned per run.** The run resolves each decider's version when it starts and records
  it in `decider_versions`; every item is answered under that question set, so an edit
  landing mid-run cannot grade half the items under other criteria. A baseline graded
  under another version is still compared: read `decider_versions` on both runs.
- **One decision per item attempt**, requested as the run with `metadata` `{ eval_id,
  eval_run_id, dataset_item_id }` and read back through `decision_id`. Its spend is the
  decision's own (`source: decider` in [usage](./usage.md)).
- **No credential.** Like every scorer, the decision is requested with none, so a
  `builtin` step in a pipeline behind the decider fails the decision; `http` tools,
  pipelines of them and a tool-less agent answer.
- **Errors are not zeros.** A failed decision, or a `score` that is not a number in 0–1,
  errors the item with the decision's id and code in `error`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-eval --project-id "$PROJECT_ID" --name reply-suite \
  --agent-id "$AGENT_ID" --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"decider","name":"reply_review","decider_id":"'"$DECIDER_ID"'","score":{"var":"answers_by_name.resolves_issue.probability"},"pass_threshold":0.7}]' \
  --pass-threshold 0.8
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.createEval({
  body: {
    project_id: projectId,
    name: 'reply-suite',
    agent_id: agentId,
    dataset_id: datasetId,
    scorers: [
      {
        type: 'decider',
        name: 'reply_review',
        decider_id: deciderId,
        score: { var: 'answers_by_name.resolves_issue.probability' },
        pass_threshold: 0.7,
      },
    ],
    pass_threshold: 0.8,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/evals \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "reply-suite",
    "agent_id": "'"$AGENT_ID"'",
    "dataset_id": "'"$DATASET_ID"'",
    "scorers": [{"type":"decider","name":"reply_review","decider_id":"'"$DECIDER_ID"'","score":{"var":"answers_by_name.resolves_issue.probability"},"pass_threshold":0.7}],
    "pass_threshold": 0.8
  }'
```

</TabItem>
</Tabs>

### Frozen inputs

Each result carries its own copy of the item's `input` and `expected_output`, taken at run
time, so editing or deleting an item between two runs cannot make their scores
incomparable. Deleting an item nulls `dataset_item_id` on past results and changes nothing
else.

### Curating items from production

`create-dataset-item-from-generation` promotes a real turn into a dataset item:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-dataset-item-from-generation \
  --dataset-id "$DATASET_ID" \
  --generation-id "$GENERATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.createDatasetItemFromGeneration({
  path: { dataset_id: datasetId },
  body: { generation_id: generationId },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/datasets/$DATASET_ID/items/from-generation" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"generation_id": "'"$GENERATION_ID"'"}'
```

</TabItem>
</Tabs>

The generation's stored input becomes the item's `input` and its answer becomes
`expected_output` (`--expected-output` overrides it; `null` stores no reference answer).
`source_generation_id` records the source. The item is a **copy**: it survives a purge of
the source generation's content, and `source_generation_id` goes null when that generation
is deleted.

- **Only a completed generation.** A paused (`requires_action`) or failed turn is refused
  with `409 GENERATION_NOT_COMPLETED`.
- **Only while its content is available.** An agent or project running with
  `trace_content_mode: none` never stored the input, and a purged or expired generation no
  longer has it. Both answer `409 GENERATION_CONTENT_UNAVAILABLE`, as do generations
  produced before input recording existed. See [content retention](#retention-and-erasure).

The call requires `generations:GetGeneration` in addition to `evaluations:CreateDataset`.
The generation must belong to the same project as the dataset.

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
   otherwise it is true when the **pass rate** (passed items over non-errored items) is at
   least the threshold.

The verdict gates on the pass rate, never on a pooled mean; `aggregate_scores` still
reports per-scorer means. A run that scored nothing does not pass.

### Errors are not zeros

An item whose generation did not complete (e.g. paused in `requires_action` for
client-side tool outputs), or whose scorer could not reach a verdict (an `llm_judge` call
failing or unparseable), is recorded as an **error**: excluded from `aggregate_scores`,
counted in `errored_count`, never scored 0. When the **generation** produced nothing,
`output` is `null`; when a **scorer** failed over a good generation, `output` is kept
alongside the `error`. The generation stays linked either way.

### Synchronous and queued runs

`wait` selects how a run executes (see [sync vs async](../advanced/sync-and-async.md)).
Both modes share one execution and finalize path.

| `wait` | Behavior |
| --- | --- |
| `true` | Executes items sequentially in-process and returns the run **terminal**, with its scores. Capped at **25 items** — a larger dataset is rejected with `400`. |
| `false` (default) | Enqueues one task per item and returns immediately with `status: "queued"`. No item cap. |

An **empty** dataset is rejected in both modes.

For a queued run, a worker claims tasks in batches; the one that drains the run's
**last** task settles it and fires [`eval_run.completed`](#lifecycle-webhooks). Poll
[`GET /evals/{eval_id}/runs/{eval_run_id}`](/docs/api/evaluations/get-eval-run) or subscribe to the webhook. Task delivery is
at-least-once, but a result row is unique per `(run, item)` and settling is an atomic
claim, so the completion event fires exactly once.

A background reaper settles non-terminal runs that have gone quiet past a grace period
(30 minutes by default): a run whose items all have results is finalized; a run with items
missing and no outstanding work is settled `failed` and `eval_run.failed` fires. A run
that still has queued tasks is left alone.

### Run metadata

`start-eval-run` accepts a `metadata` bag: caller-owned key/value annotations, stored on the run and returned verbatim by every read of it, the list included. Use it to record what the run measured — the commit or release candidate, the CI job, the experiment. `trigger_id` records a *scheduled* origin; `metadata` records the caller's own.

Nothing in the scoring path reads it, and no key is reserved: `status`, `agent_version`, `aggregate_scores`, `passed` and the counts are fields of their own and cannot be written from here. A non-object `metadata` is rejected with `400 VALIDATION_FAILED` and no run is created.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-eval-run \
  --eval-id "$EVAL_ID" \
  --metadata '{"commit_sha":"9f2c1ab","ci_job":"nightly-evals"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.startEvalRun({
  path: { eval_id: evalId },
  body: { metadata: { commit_sha: '9f2c1ab', ci_job: 'nightly-evals' } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"commit_sha":"9f2c1ab","ci_job":"nightly-evals"}}'
```

</TabItem>
</Tabs>

Filtering runs by a metadata key is not supported — fetch and filter client-side.

### Run tool context

An agent whose tools authorize through [`tool_context`](../advanced/tool-context.md) needs the bag to be scored: a tool declaring `Authorization: Bearer {{context:...}}` fails every item with `MISSING_TOOL_CONTEXT_KEY`, and one that tolerates a missing key scores a configuration other than production's.

`start-eval-run` accepts a `tool_context` bag, forwarded to every item's generation:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-eval-run \
  --eval-id "$EVAL_ID" \
  --wait true \
  --tool-context '{"ocaToken":"eyJhbGciOiJIUzI1NiJ9.abc","tenant":"acme"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.startEvalRun({
  path: { eval_id: evalId },
  body: {
    wait: true,
    tool_context: { ocaToken: 'eyJhbGciOiJIUzI1NiJ9.abc', tenant: 'acme' },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"wait": true, "tool_context": {"ocaToken":"eyJhbGciOiJIUzI1NiJ9.abc","tenant":"acme"}}'
```

</TabItem>
</Tabs>

Unlike `metadata`:

- **It lives on the run, not the request.** A queued run (the default, and the only shape a [scheduled](#scheduled-runs) one has) is driven by a worker with no request behind it, so the bag is stored on the run row and re-read for every item.
- **It is write-only.** No read of the run returns it.
- **It does not outlive the work.** The bag is cleared once the run reaches a terminal state.

The usual `tool_context` rules apply: each key is forwarded as one `X-Soat-Context-<key>` header and resolves any `{{context:}}` token in a bound tool's headers or [`preset_parameters`](../advanced/tool-context.md#pinning-a-parameter-to-the-runs-value), a tool's [`context_keys`](./tools.md#scoping-which-context-keys-reach-a-tool) narrows what reaches it, and a key that could not become a header name is rejected with `400 INVALID_TOOL_CONTEXT_KEY` before any run is created. An eval generation has no session, so the reserved identity keys (`session_id`, `actor_id`, `actor_external_id`) are dropped rather than forwarded.

### Canceling a run

[`POST /evals/{eval_id}/runs/{eval_run_id}/cancel`](/docs/api/evaluations/cancel-eval-run) drops a queued or running run's
outstanding tasks and settles it `canceled`; a run that has already finished is rejected
with `400`. Results already written are **kept**, and `completed_count` /
`errored_count` report what ran — an item a worker had already claimed runs to completion
and recounts the run after it settles. `aggregate_scores` is left `null` (a partial
roll-up would read as a whole-dataset verdict), and no lifecycle event fires. The run's
[`tool_context`](#run-tool-context) is cleared, as on any terminal transition.

### Scheduled runs

A [trigger](./triggers.md) with `target_type: "eval"` runs a suite on a cadence. Every
starter works (manual, webhook, and cron `schedule`), and the firing always starts a
**queued** run; the firing's `result.result_id` is the `evrun_…` to poll. The run records
its origin in `trigger_id` and keeps it if the trigger is later deleted.

The trigger's `input` may carry `agent_version` and `baseline_run_id`, validated at fire
time: a stale version fails the **firing** (reason on the firing record) instead of
creating a run. Creating an eval-target trigger requires `evaluations:RunEval` on top of
`triggers:CreateTrigger`. A trigger carries no [`tool_context`](#run-tool-context); an
eval whose agent needs one has to be started through the API.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-trigger \
  --project-id "$PROJECT_ID" \
  --name nightly-regression \
  --type schedule \
  --target-type eval \
  --target-id "$EVAL_ID" \
  --cron "0 3 * * *"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.triggers.createTrigger({
  body: {
    project_id: projectId,
    name: 'nightly-regression',
    type: 'schedule',
    target_type: 'eval',
    target_id: evalId,
    cron: '0 3 * * *',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/triggers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "nightly-regression",
    "type": "schedule",
    "target_type": "eval",
    "target_id": "'"$EVAL_ID"'",
    "cron": "0 3 * * *"
  }'
```

</TabItem>
</Tabs>

### Formation support

Datasets, their items, and evals are declarable in a [Formation](./formations.md) template:

| Resource type | Properties |
| --- | --- |
| `dataset` | `name`, `description` |
| `dataset_item` | `dataset_id`, `input`, `expected_output`, `metadata` |
| `eval` | `name`, `agent_id`, `dataset_id`, `scorers`, `pass_threshold`, `group_by` |

Items are their own resource, so an item curated through the API is never collateral of a
formation apply. `dataset_id` is immutable on a `dataset_item`. Running the suite gives
the agent under test generation history, so deleting the formation fails with
`409 FORMATION_DELETE_FAILED` naming that agent ([formation teardown](./formations.md#resource-lifecycle)):
force-delete the agent ([`DELETE /api/v1/agents/{agent_id}?force=true`](/docs/api/agents/delete-agent))
or declare it with `deletion_policy: retain`.

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
| `flipped` | `improved` (passed here, failed in the baseline) and `regressed` (the reverse) among the compared items |
| `p_value` | Exact McNemar p-value of the `flipped` split; see [Uncertainty](#uncertainty) |
| `scorers` | Per scorer type, `mean_delta` and `pass_rate_delta` |

Positive deltas mean this run scored **higher**. Every number is computed over the
**item intersection**, recomputing both sides, so dataset drift shows up in the counts. A
scorer that only one run ran is omitted.

When the eval declares a `group_by`, `baseline.grouping` holds the same comparison per
group; see [Grouped aggregates](#grouped-aggregates).

### Grouped aggregates

A run's pass rate can hold steady while one kind of item collapses. `group_by` names a key
of the items' `metadata`, and every run rolls its scores up per value of that key beside
the run-level figures:

```json
{
  "pass_rate": 0.6,
  "scored_item_count": 5,
  "grouping": {
    "group_by": "kind",
    "groups": {
      "multi_step": {
        "pass_rate": 1,
        "pass_rate_interval": { "low": 0.21, "high": 1, "level": 0.95 },
        "scored_item_count": 1,
        "scorers": { "contains": { "mean": 1, "pass_rate": 1 } }
      },
      "refusal": {
        "pass_rate": 0.5,
        "pass_rate_interval": { "low": 0.09, "high": 0.91, "level": 0.95 },
        "scored_item_count": 2,
        "scorers": { "contains": { "mean": 0.5, "pass_rate": 0.5 } }
      }
    },
    "ungrouped_item_count": 2
  }
}
```

| Field | Meaning |
| --- | --- |
| `grouping.group_by` | The key the groups were read from |
| `grouping.groups` | Group value → its `pass_rate`, `pass_rate_interval`, `scored_item_count` and per-scorer `mean` / `pass_rate`, computed as the run's own are |
| `grouping.ungrouped_item_count` | Scored items that name no group |

- **Only a string names a group.** An item whose `metadata` lacks the key, holds a
  non-string under it (`7`, `true`, an object), or whose dataset item was deleted counts in
  `ungrouped_item_count`. Values are not coerced, so `"1"` and `1` never merge.
- **Errored items count in no group**, as they count in no run-level figure
  ([Errors are not zeros](#errors-are-not-zeros)).
- **Labels are read when the run settles**, from the items' `metadata` at that moment, and
  stored with the aggregate. With a baseline, both runs' items are grouped by those same
  labels, so `baseline.grouping.groups` compares each group over the items both runs
  scored, with the same `compared_item_count` / `added_item_count` /
  `removed_item_count` / `pass_rate_delta` / `flipped` / `p_value` / `scorers` fields as
  [Baseline deltas](#baseline-deltas). Its `ungrouped_item_count` counts the compared items
  that name no group.
- **The verdict does not read groups.** `passed` gates on the run's pass rate only
  ([Pass semantics](#pass-semantics)). A kind that needs its own threshold gets its own
  dataset and eval.

`group_by` is set on create or update (`null` clears it) and applies to the runs that
settle afterwards; a settled run keeps the grouping it was stored with. Omitted, a run
reports no `grouping`.

### Uncertainty

A pass rate measured over 20 items moves by `0.05` per item, and an agent that is not
deterministic answers the same item differently from run to run. Every run reports how far
its figures can be trusted, with no extra call:

```json
{
  "pass_rate": 0.75,
  "pass_rate_interval": { "low": 0.63, "high": 0.84, "level": 0.95 },
  "baseline": {
    "pass_rate_delta": 0.05,
    "compared_item_count": 60,
    "flipped": { "improved": 9, "regressed": 6 },
    "p_value": 0.61
  }
}
```

| Figure | Reads |
| --- | --- |
| `pass_rate_interval` | The 95% [Wilson score interval](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval) around `pass_rate`: where the pass rate of this agent over items like these plausibly lies, given how many were scored. It stays inside 0–1 and keeps its coverage on a handful of items. `null` exactly when `pass_rate` is |
| `baseline.flipped` | The compared items that changed verdict; `pass_rate_delta` is `(improved − regressed) / compared_item_count` |
| `baseline.p_value` | The exact two-sided [McNemar](https://en.wikipedia.org/wiki/McNemar%27s_test) p-value of that split: how likely a split at least this uneven is when an item is equally likely to flip either way, which is what an unchanged agent produces, whether the flips come from the model's randomness or from borderline items. `1` when nothing flipped; `null` when the runs share no compared item |

- **A small `p_value` says the change is real, not that it is large.** `9` improved against
  `6` regressed is `p = 0.61`: indistinguishable from noise. `6` against `0` is
  `p = 0.03`.
- **A wide interval says the dataset is too small to decide.** At 12 items and a pass
  rate of `0.5` the interval is `0.25`–`0.75`: add items before reading a delta.
- **Groups carry both.** Each `grouping.groups` entry has its own `pass_rate_interval`, and
  each `baseline.grouping.groups` entry its own `flipped` and `p_value`, so a kind that
  regressed shows as significant even when the overall delta is not.
- **The verdict reads neither.** `passed` gates on `pass_rate` alone
  ([Pass semantics](#pass-semantics)); the figures are there to read beside it. Choosing a
  `pass_threshold` with them: [Eval Design — Noise before signal](../advanced/eval-design.md#noise-before-signal).

### Lifecycle webhooks

Two [webhook](./webhooks.md) events carry a run's outcome:

| Event | Fires when |
| --- | --- |
| `eval_run.completed` | A run reached a terminal status with its items scored |
| `eval_run.failed` | A run could not be executed to completion |

Both carry `{ eval_id, eval_run_id, passed, aggregate_scores }` inline, so a promotion
gate needs no second call. Exactly one event fires per terminal run.

### Eval spend is separable from production spend

Every item is a real generation, and `llm_judge` doubles the calls. Eval spend is labelled
in [usage](./usage.md) metering: item generations carry `source: "eval"` and judge
completions `source: "eval_judge"` (ordinary agent traffic carries no `source`). Filter
with [`GET /api/v1/usage/events?source=eval`](/docs/api/usage/list-usage-events) or roll up with
[`GET /api/v1/usage/aggregate?group_by=source`](/docs/api/usage/get-usage-aggregate). [Quotas](./quotas.md) and usage thresholds still
apply to eval runs.

An `embedding_similarity` scorer's embeddings are metered under `source: "embedding"`
rather than `"eval_judge"`: they go through the deployment's
[embedding](./embeddings.md#metering) stack, not a project provider, so they carry that
stack's provider and model.

:::warning[Eval runs have real side effects]

A run creates real generations, so an agent with a write-capable `http` or `mcp`
[tool](./tools.md) performs N real writes per run. There is no tool-stub mode. Point an
eval'd agent's tools at a staging target.

:::

### Retention and erasure

`EvalResult.output` is a copy of a generation's content, so purging that content
(directly, or through its trace) clears the copy. Scores, `passed`, and the frozen
`input` / `expected_output` survive. A content purge never deletes or mutates a dataset
item, including one curated with
[`create-dataset-item-from-generation`](#curating-items-from-production); deleting the
item is the only way to erase it.

Because only `output` is cleared, the corpus is not bounded by a project's retention
window: every item and every frozen result counts toward the project's stored
gigabytes ([`gb_day`](./usage.md#storage-metering)) until the dataset item or the run is
deleted.

### Who may act on a dataset or an eval

Every route that acts on one dataset or one eval is authorized against **that
resource's** SRN — `srn:<project_id>:dataset:<dataset_id>` or
`srn:<project_id>:eval:<eval_id>` — not against the project. A policy may
therefore name the datasets and evals it covers:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["evaluations:GetEval", "evaluations:RunEval"],
      "resource": ["srn:proj_V1StGXR8Z5jdHi6B:eval:eval_V1StGXR8Z5jdHi6B"]
    }
  ]
}
```

A dataset **item** and an eval **run** have no SRN of their own: they authorize
through the parent named in the path, so the statement above covers every run of
that eval, and a dataset grant covers every item in that dataset.

Curating an item from a generation ([`POST /api/v1/datasets/{dataset_id}/items/from-generation`](/docs/api/evaluations/create-dataset-item-from-generation)) checks both halves: `evaluations:CreateDataset` against the dataset, and `generations:GetGeneration` against the generation being copied — so it can never become a way to read a turn the caller could not fetch directly.

Refusals keep the shapes [IAM](./iam.md#what-a-denial-looks-like) defines: a read the caller may not perform is `404` (a dataset or eval it may not see does not announce itself, across projects or within one), a write or a run is `403`, and a credential scoped to another project is `403 API_KEY_PROJECT_SCOPE`. A write on a resource in a project none of the caller's policies name is `404` too — the same answer their read would get, so a refusal never confirms existence across a tenant boundary.

Listing datasets and evals stays project-scoped: [`GET /api/v1/datasets`](/docs/api/evaluations/list-datasets) and [`GET /api/v1/evals`](/docs/api/evaluations/list-evals) ask whether the caller may list in a project at all, so a policy that names individual datasets or evals grants no listing.

## Examples

Create a dataset and add a case:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-dataset --project-id "$PROJECT_ID" --name billing-regressions

soat create-dataset-item --dataset-id "$DATASET_ID" \
  --input '[{"role":"user","content":"When is my invoice issued?"}]' \
  --expected-output "On the first of each month." \
  --metadata '{"topic":"billing"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const dataset = await soat.evaluations.createDataset({
  body: { project_id: projectId, name: 'billing-regressions' },
});
if (dataset.error) throw new Error(JSON.stringify(dataset.error));

const item = await soat.evaluations.createDatasetItem({
  path: { dataset_id: datasetId },
  body: {
    input: [{ role: 'user', content: 'When is my invoice issued?' }],
    expected_output: 'On the first of each month.',
    metadata: { topic: 'billing' },
  },
});
if (item.error) throw new Error(JSON.stringify(item.error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/datasets \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "'"$PROJECT_ID"'", "name": "billing-regressions"}'

curl -X POST "https://api.example.com/api/v1/datasets/$DATASET_ID/items" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [{"role":"user","content":"When is my invoice issued?"}],
    "expected_output": "On the first of each month.",
    "metadata": {"topic":"billing"}
  }'
```

</TabItem>
</Tabs>

Bind an eval and gate it at an 80% pass rate:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-eval --project-id "$PROJECT_ID" --name billing-regression-suite \
  --agent-id "$AGENT_ID" --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"contains","value":"first of each month"}]' \
  --pass-threshold 0.8
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.createEval({
  body: {
    project_id: projectId,
    name: 'billing-regression-suite',
    agent_id: agentId,
    dataset_id: datasetId,
    scorers: [{ type: 'contains', value: 'first of each month' }],
    pass_threshold: 0.8,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/evals \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "billing-regression-suite",
    "agent_id": "'"$AGENT_ID"'",
    "dataset_id": "'"$DATASET_ID"'",
    "scorers": [{"type":"contains","value":"first of each month"}],
    "pass_threshold": 0.8
  }'
```

</TabItem>
</Tabs>

Run it synchronously and read the per-item results:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-eval-run --eval-id "$EVAL_ID" --wait true
soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const run = await soat.evaluations.startEvalRun({
  path: { eval_id: evalId },
  body: { wait: true },
});
if (run.error) throw new Error(JSON.stringify(run.error));

const results = await soat.evaluations.listEvalResults({
  path: { eval_id: evalId, eval_run_id: runId },
});
if (results.error) throw new Error(JSON.stringify(results.error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"wait": true}'

curl "https://api.example.com/api/v1/evals/$EVAL_ID/runs/$RUN_ID/results" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Queue a larger run and poll for the verdict:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-eval-run --eval-id "$EVAL_ID" --wait false   # → status: queued
soat get-eval-run --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID"
soat cancel-eval-run --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const run = await soat.evaluations.startEvalRun({
  path: { eval_id: evalId },
  body: { wait: false }, // → status: queued
});
if (run.error) throw new Error(JSON.stringify(run.error));

const polled = await soat.evaluations.getEvalRun({
  path: { eval_id: evalId, eval_run_id: runId },
});
if (polled.error) throw new Error(JSON.stringify(polled.error));

const canceled = await soat.evaluations.cancelEvalRun({
  path: { eval_id: evalId, eval_run_id: runId },
});
if (canceled.error) throw new Error(JSON.stringify(canceled.error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"wait": false}'   # → status: queued

curl "https://api.example.com/api/v1/evals/$EVAL_ID/runs/$RUN_ID" \
  -H "Authorization: Bearer <token>"

curl -X POST "https://api.example.com/api/v1/evals/$EVAL_ID/runs/$RUN_ID/cancel" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Evaluate a specific archived version against a baseline — the shape a promotion gate uses:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-eval-run --eval-id "$EVAL_ID" --wait true \
  --agent-version 3 --baseline-run-id "$BASELINE_RUN_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.evaluations.startEvalRun({
  path: { eval_id: evalId },
  body: { wait: true, agent_version: 3, baseline_run_id: baselineRunId },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"wait": true, "agent_version": 3, "baseline_run_id": "'"$BASELINE_RUN_ID"'"}'
```

</TabItem>
</Tabs>
