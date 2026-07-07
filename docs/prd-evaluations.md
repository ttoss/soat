# PRD: Evaluations & Datasets

> Closes the biggest verification gap in the platform: SOAT records what agents
> *did* (traces, generations) and will constrain what they *may do*
> ([prd-guardrails.md](./prd-guardrails.md),
> [prd-approvals.md](./prd-approvals.md)) — but nothing verifies agent behavior
> **before** a change rolls out. Cross-references
> [prd-orchestration-queue.md](./prd-orchestration-queue.md) (async execution),
> [prd-usage-metering.md](./prd-usage-metering.md) (cost attribution),
> [prd-schedules.md](./prd-schedules.md) (scheduled evals), and
> `docs/prd-agent-versions.md` (eval-gated promotion; written in parallel).

## Implementation Status

| Component                                        | Status         | Notes                                                              |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------ |
| `Dataset` + `DatasetItem` models + CRUD          | ❌ Not started | `dset_` / `dsit_` prefixes                                          |
| `Eval` config model + CRUD                       | ❌ Not started | `eval_` prefix; target agent + dataset + scorer list                |
| `EvalRun` / `EvalResult` execution models        | ❌ Not started | `evrun_` / `evres_` prefixes                                        |
| Deterministic scorers (`exact_match`, `contains`, `json_logic`, `output_schema`) | ❌ Not started | `json_logic` reuses `src/lib/jsonLogicMapping.ts` |
| Sync small-run execution                         | ❌ Not started | `wait: true`, capped item count                                     |
| `llm_judge` scorer                               | ❌ Not started | Judge via ai-providers + `completionModel.ts` resolution            |
| Async execution on the RunTask queue             | ❌ Not started | Per-item tasks; [prd-orchestration-queue.md](./prd-orchestration-queue.md) Phase 1 |
| Baseline comparison + pass/fail gating           | ❌ Not started | `baseline_run_id`, per-scorer deltas, `pass_threshold`              |
| Webhook events (`eval_run.completed` / `.failed`)| ❌ Not started | Existing webhooks module                                            |
| Curate dataset items from traces/generations     | ❌ Not started | `POST /datasets/{dataset_id}/items/from-generation`                 |
| Scheduled evals + `eval` formation resource type | ❌ Not started | [prd-schedules.md](./prd-schedules.md); `formations.yaml` sync      |

## Problem

An agent author who changes an instruction, swaps a model, or adds a tool has
no way to answer "did this make the agent worse?" other than eyeballing a few
manual conversations. Traces and generations are forensic — they explain an
incident after the fact. The knowledge PRD's Phase 7 harness
([prd-knowledge.md](./prd-knowledge.md)) measures **retrieval** quality
(recall@k, MRR over a golden query set), not end-to-end agent behavior. And
the upcoming agent-versioning work (`docs/prd-agent-versions.md`) needs a
machine-checkable gate for promoting a new agent version — a gate that cannot
exist until something produces a pass/fail verdict.

This PRD adds that verdict: project-scoped **datasets** of test cases, **eval**
configurations binding an agent to a dataset and a list of scorers, and **eval
runs** that execute the real agent against every item and score the outputs.

## Goals

- Declare a repeatable test suite for a user agent (dataset + scorers) and run
  it on demand, getting per-item and aggregate scores.
- Score deterministically (exact/contains/JSON Logic/schema) and by LLM judge.
- Compare a run against a named baseline run and gate on a pass threshold —
  the primitive `docs/prd-agent-versions.md` consumes for eval-gated promotion.
- Bootstrap datasets from real production traffic (traces/generations).
- Attribute eval-generated LLM cost separately from production cost.

## Non-Goals

- **No UI** — REST/SDK/CLI/MCP only; the app view is a separate effort.
- **No fine-tuning** — eval results never feed a training loop here.
- **No human-annotation queues** — a future phase may add a `human` scorer
  that parks results as `pending_review`; sketched only, not designed.
- **Not a replacement for the knowledge retrieval harness** — prd-knowledge.md
  Phase 7 stays as specified; once this module exists it should be
  re-expressed as an Eval with a dedicated retrieval scorer (noted there, not
  built here).

## Data Model

Prefixes below are non-colliding against
`packages/postgresdb/src/utils/publicId.ts` and must be registered there
(2–7 chars before the underscore).

### Dataset (`dset_`)

| Column      | Type        | Constraints                          |
| ----------- | ----------- | ------------------------------------ |
| id          | INTEGER     | PK                                   |
| publicId    | VARCHAR(32) | UNIQUE, `dset_` prefix               |
| projectId   | INTEGER     | FK → Project, NOT NULL               |
| name        | VARCHAR     | NOT NULL, unique per project         |
| description | TEXT        | NULL                                 |
| createdAt / updatedAt | TIMESTAMP | NOT NULL                   |

Indexes: unique `(projectId, name)`, `(projectId)`.

### DatasetItem (`dsit_`)

| Column         | Type        | Constraints                                              |
| -------------- | ----------- | -------------------------------------------------------- |
| id             | INTEGER     | PK                                                       |
| publicId       | VARCHAR(32) | UNIQUE, `dsit_` prefix                                   |
| datasetId      | INTEGER     | FK → Dataset, NOT NULL, CASCADE delete                   |
| input          | JSONB       | NOT NULL; array of `{role, content}` messages            |
| expectedOutput | TEXT        | NULL; reference answer for `exact_match`/`llm_judge`     |
| metadata       | JSONB       | NULL; free-form tags (e.g. `{"topic": "billing"}`)       |
| sourceGenerationId | INTEGER | FK → Generation, NULL; set when curated from a trace     |
| createdAt / updatedAt | TIMESTAMP | NOT NULL                                       |

Indexes: `(datasetId)`, `(sourceGenerationId)`.

### Eval (`eval_`)

| Column        | Type        | Constraints                                                  |
| ------------- | ----------- | ------------------------------------------------------------- |
| id            | INTEGER     | PK                                                            |
| publicId      | VARCHAR(32) | UNIQUE, `eval_` prefix                                        |
| projectId     | INTEGER     | FK → Project, NOT NULL                                        |
| name          | VARCHAR     | NOT NULL, unique per project                                  |
| agentId       | INTEGER     | FK → Agent, NOT NULL (the agent under test)                   |
| datasetId     | INTEGER     | FK → Dataset, NOT NULL (same project — validated in lib)      |
| scorers       | JSONB       | NOT NULL; array of scorer configs (discriminated union below) |
| passThreshold | DECIMAL     | NULL; 0–1; run `passed` iff mean score ≥ threshold            |
| createdAt / updatedAt | TIMESTAMP | NOT NULL                                            |

Indexes: unique `(projectId, name)`, `(projectId)`, `(agentId)`.

### EvalRun (`evrun_`)

| Column          | Type        | Constraints                                                        |
| --------------- | ----------- | ------------------------------------------------------------------ |
| id              | INTEGER     | PK                                                                 |
| publicId        | VARCHAR(32) | UNIQUE, `evrun_` prefix                                            |
| evalId          | INTEGER     | FK → Eval, NOT NULL                                                |
| status          | VARCHAR     | `queued` \| `running` \| `completed` \| `failed` \| `canceled`     |
| baselineRunId   | INTEGER     | FK → EvalRun, NULL; must belong to the same Eval                   |
| aggregateScores | JSONB       | NULL until terminal; per-scorer mean/pass-rate + deltas vs baseline|
| passed          | BOOLEAN     | NULL when no `passThreshold` on the Eval                           |
| itemCount / completedCount / erroredCount | INTEGER | NOT NULL DEFAULT 0                       |
| startedAt / finishedAt | TIMESTAMP | NULL                                                       |
| createdAt       | TIMESTAMP   | NOT NULL                                                           |

Indexes: `(evalId, createdAt)`.

### EvalResult (`evres_`)

| Column        | Type        | Constraints                                                      |
| ------------- | ----------- | ----------------------------------------------------------------- |
| id            | INTEGER     | PK                                                                |
| publicId      | VARCHAR(32) | UNIQUE, `evres_` prefix                                           |
| evalRunId     | INTEGER     | FK → EvalRun, NOT NULL, CASCADE delete                            |
| datasetItemId | INTEGER     | FK → DatasetItem, NOT NULL                                        |
| generationId  | INTEGER     | FK → Generation, NULL (null when the generation itself errored)   |
| output        | TEXT        | NULL; the agent's final output text                               |
| scores        | JSONB       | NOT NULL; `[{scorer, score, passed, reasoning?}]` per scorer      |
| passed        | BOOLEAN     | NOT NULL; AND over per-scorer `passed`                            |
| error         | TEXT        | NULL; item-level failure reason                                   |
| createdAt     | TIMESTAMP   | NOT NULL                                                          |

Indexes: `(evalRunId)`, unique `(evalRunId, datasetItemId)` — one result per
item per run, which also makes queue redelivery idempotent.

## Scorers

`Eval.scorers` is an extensible discriminated union on `type` (snake_case in
REST bodies per the case convention):

| `type`          | Config                                                          | Score                                        |
| --------------- | --------------------------------------------------------------- | -------------------------------------------- |
| `exact_match`   | — (compares output to `expected_output`, trimmed)               | 0 or 1                                       |
| `contains`      | `value`, `case_sensitive` (default false)                       | 0 or 1                                       |
| `json_logic`    | `expression` — JSON Logic over `{input, output, expected, item.metadata}` | truthy → 1, falsy → 0              |
| `output_schema` | — validates output against the agent's existing `output_schema` | 0 or 1                                       |
| `llm_judge`     | `ai_provider_id`, `model`, `prompt` with `{{input}}` / `{{output}}` / `{{expected}}` slots | 0–1 + `reasoning` |

**Decision:** `json_logic` reuses the shared `LogicEngine` in
`packages/server/src/lib/jsonLogicMapping.ts` (`evaluateLogic`) — the same
engine orchestration mappings use — so assertion semantics are identical
everywhere and no second expression language enters the platform.

**Decision:** `llm_judge` resolves its model through the existing
ai-providers + `completionModel.ts` path rather than a dedicated judge config —
judges are just completions, and they meter/trace like any other call.

**Decision:** every scorer returns `{score: 0–1, passed: boolean}`; binary
scorers emit 0/1. One shape keeps aggregation, deltas, and thresholds
scorer-agnostic, so new scorer types need no aggregation changes.

## Execution

Starting a run snapshots the dataset's items and creates one **real agent
generation per item** through the existing `createGeneration` machinery — the
run exercises the agent's true instructions, tools, model, and knowledge, and
each `EvalResult` links its `generation_id`/trace for drill-down.

**Decision:** async runs enqueue **one task per dataset item on the existing
`RunTask` queue** ([prd-orchestration-queue.md](./prd-orchestration-queue.md)
Phase 1, new `kind: eval_item`) rather than inventing a second worker — leases,
redelivery, and concurrency limits come for free, and the unique
`(evalRunId, datasetItemId)` constraint makes redelivered items no-ops.

**Decision:** eval generations are attributed with `source: eval` at the
usage-metering choke point ([prd-usage-metering.md](./prd-usage-metering.md))
so eval spend is separable from production spend in cost rollups.

### Baselines and gating

`POST /evals/{eval_id}/runs` accepts `baseline_run_id` (a terminal run of the
same Eval). On completion, `aggregate_scores` includes per-scorer deltas
against the baseline, and `passed` is computed from `pass_threshold`. Webhook
events `eval_run.completed` and `eval_run.failed` fire through the existing
webhooks module with `{eval_id, eval_run_id, passed, aggregate_scores}` —
this event + verdict pair is the promotion gate consumed by
`docs/prd-agent-versions.md`.

## REST API

Snake_case bodies; MCP tools and SDK/CLI derive from the OpenAPI spec
(`packages/server/src/rest/openapi/v1/evaluations.yaml`) via `soatTools.ts`.

| Method | Path                                                    | Description                                    |
| ------ | ------------------------------------------------------- | ---------------------------------------------- |
| POST/GET | `/api/v1/datasets`                                    | Create / list datasets (`project_id` filter)   |
| GET/PUT/DELETE | `/api/v1/datasets/{dataset_id}`                 | Get / update / delete a dataset                |
| POST/GET | `/api/v1/datasets/{dataset_id}/items`                 | Add / list items                               |
| PUT/DELETE | `/api/v1/datasets/{dataset_id}/items/{item_id}`     | Update / delete an item                        |
| POST   | `/api/v1/datasets/{dataset_id}/items/from-generation`   | Curate an item from a generation (Phase 2)     |
| POST/GET | `/api/v1/evals`                                       | Create / list evals                            |
| GET/PUT/DELETE | `/api/v1/evals/{eval_id}`                       | Get / update / delete an eval                  |
| POST   | `/api/v1/evals/{eval_id}/runs`                          | Start a run (`wait`, `baseline_run_id`)        |
| GET    | `/api/v1/evals/{eval_id}/runs`                          | List runs                                      |
| GET    | `/api/v1/evals/{eval_id}/runs/{run_id}`                 | Run status + aggregate scores + deltas         |
| GET    | `/api/v1/evals/{eval_id}/runs/{run_id}/results`         | Per-item results (paginated)                   |
| POST   | `/api/v1/evals/{eval_id}/runs/{run_id}/cancel`          | Cancel a queued/running run                    |

## Permissions

Actions defined in `packages/server/src/permissions/evaluations.json`.

| Permission                     | Endpoints                                        |
| ------------------------------ | ------------------------------------------------ |
| `evaluations:CreateDataset`    | `POST /datasets`, item create/update/delete, `from-generation` |
| `evaluations:ListDatasets`     | `GET /datasets`, `GET .../items`                 |
| `evaluations:GetDataset`       | `GET /datasets/{dataset_id}`                     |
| `evaluations:DeleteDataset`    | `DELETE /datasets/{dataset_id}`                  |
| `evaluations:CreateEval`       | `POST /evals`, `PUT /evals/{eval_id}`            |
| `evaluations:ListEvals`        | `GET /evals`, `GET .../runs`, `GET .../results`  |
| `evaluations:GetEval`          | `GET /evals/{eval_id}`, `GET .../runs/{run_id}`  |
| `evaluations:DeleteEval`       | `DELETE /evals/{eval_id}`                        |
| `evaluations:RunEval`          | `POST .../runs`, `POST .../runs/{run_id}/cancel` |

`from-generation` additionally requires read access to the source generation
(`generations:GetGeneration`).

## Implementation Phases

The full module checklist in `.claude/rules/modules.md` applies to every
phase: lib in `src/lib/evaluations.ts`, REST + `@openapi` blocks + YAML spec,
permissions JSON, `pnpm --filter @soat/sdk generate` +
`pnpm --filter @soat/cli generate`, module doc at
`packages/website/docs/modules/evaluations.md`, tests in
`tests/unit/tests/rest/evaluations.test.ts` (+ `lib/` scorer tests under the
keep-list rule: pure algorithms with large input spaces), smoke-test steps.

### Phase 1 — Datasets + Evals + Sync Deterministic Runs ❌ Not started

Datasets/items CRUD, Eval CRUD, and synchronous execution (`wait: true`,
dataset capped at 25 items for sync) with `exact_match`, `contains`,
`json_logic`, and `output_schema` scorers.

**Acceptance criteria:**

- All Phase-1 routes return documented shapes; `401` unauthenticated, `403`
  without the mapped action, `404` cross-project (tenancy tests per resource)
- Prefixes `dset_`/`dsit_`/`eval_`/`evrun_`/`evres_` registered in
  `publicId.ts`; no internal IDs in any response
- Creating an Eval whose `dataset_id` or `agent_id` belongs to another project
  returns `400`; an unknown scorer `type` returns `400` naming the field
- A sync run against a 3-item dataset with `mockCreateGeneration` produces 3
  `EvalResult` rows, one linked generation ID each, correct per-scorer 0/1
  scores for all four scorer types, and `passed` derived from `pass_threshold`
- `json_logic` scorer branch coverage via a direct `lib/` scorer test (large
  input space keep-list rule); `evaluateLogic` from `jsonLogicMapping.ts` is
  the evaluator — no new engine dependency appears in `package.json`
- SDK/CLI regenerated; smoke test drives dataset → eval → run → results via
  `$SOAT_CLI`

### Phase 2 — LLM Judge + Async Queue + Baselines + Curation ❌ Not started

`llm_judge` scorer; async runs on the `RunTask` queue (`kind: eval_item`);
`baseline_run_id` deltas; `eval_run.completed`/`.failed` webhooks;
`from-generation` curation.

**Acceptance criteria:**

- `llm_judge` renders `{{input}}`/`{{output}}`/`{{expected}}` into the prompt
  and parses `{score, reasoning}` — asserted against a local fake
  OpenAI-compatible server (tests.md pattern); a malformed judge response
  marks the item errored, not the run failed
- Async run: `POST .../runs` without `wait` returns `status: "queued"`
  immediately; a redelivered item task inserts no duplicate `EvalResult`
  (unique `(eval_run_id, dataset_item_id)` asserted, count == 1)
- Run with `baseline_run_id` returns per-scorer `delta` values equal to
  (current mean − baseline mean) within float tolerance; a baseline from a
  different Eval returns `400`
- `eval_run.completed` fires exactly once per terminal run with the documented
  payload, asserted via a webhook test receiver; `eval_run.failed` on run
  failure
- `from-generation` copies the generation's input messages and output into a
  new item with `source_generation_id` set; `404` for a generation outside the
  caller's project
- Eval generations carry `source: eval` attribution, asserted where the
  metering choke point records it (or on `Generation` metadata until
  prd-usage-metering.md Phase 1 lands)

### Phase 3 — Scheduled Evals + Formation Resource ❌ Not started

Schedules integration ([prd-schedules.md](./prd-schedules.md)) so an eval
run fires on a cron cadence; `eval` and `dataset` formation resource types.

**Acceptance criteria:**

- A schedule targeting an Eval starts a run per fire; the run records its
  schedule origin
- `EvalResourceProperties` / `DatasetResourceProperties` added to
  `formations.yaml`; `evaluationsFormationModule.ts` implements build/update/
  read; unknown-field and required-field template validation rejects with
  `400` (formationSpecLoader allowlist)
- `update-formation` round-trip: a template declaring an eval creates it,
  changing `pass_threshold` updates in place, removal deletes it
- Future sketch (not built): `human` scorer type parking results as
  `pending_review` for annotation queues

## Risks

- **Eval runs spend real money** — every item is a real generation, and
  `llm_judge` doubles the calls. Mitigated by `source: eval` attribution,
  usage-metering thresholds, the sync-run item cap, and queue concurrency
  limits; still, a 10k-item dataset is a footgun until per-run item limits are
  tuned.
- **Judge reliability** — LLM judges drift with model updates; deltas between
  runs judged by different models are not comparable. The judge model is
  pinned per scorer config, and `reasoning` is stored for audit, but baseline
  comparisons should re-run the baseline when the judge changes.
- **Queue dependency** — Phase 2 async execution assumes
  prd-orchestration-queue.md Phase 1 (`RunTask`) has shipped; until then only
  sync runs exist. Degraded-mode fallback (in-process loop) is deliberately
  not built to avoid a second execution path.
- **Flaky non-determinism** — agents are stochastic; a red run may be
  variance, not regression. Aggregate scores over datasets (not single items)
  and thresholds below 1.0 are the intended mitigation; seed/temperature
  pinning is out of scope.
