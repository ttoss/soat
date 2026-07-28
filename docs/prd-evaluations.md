# PRD: Evaluations & Datasets

> Closes the biggest verification gap in the platform: SOAT records what agents
> *did* (traces, generations) and will constrain what they *may do*
> ([guardrails](../packages/website/docs/modules/guardrails.md),
> [approvals](../packages/website/docs/modules/approvals.md)) — but nothing verifies agent behavior
> **before** a change rolls out. Cross-references the
> [durable orchestration queue](../packages/website/docs/modules/orchestrations.md#durable-background-execution) (async execution),
> the [usage module doc](../packages/website/docs/modules/usage.md) (cost attribution),
> the [Triggers module](../packages/website/docs/modules/triggers.md) (scheduled evals), and
> `docs/prd-agent-versions.md` (eval-gated promotion; written in parallel).

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
| `output_schema` | `schema` (optional JSON Schema); falls back to the agent's `output_schema`, which must be set either way | 0 or 1 — validates the generation's structured `object` output |
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

**Decision (2026-07): the `output_schema` scorer carries its own optional
`schema`; the agent's `output_schema` is only a fallback.** Binding the scorer
to the agent's *live* `output_schema` would break the module's core purpose —
regression detection against a baseline: editing the agent between two runs
would silently re-score them against **different** schemas, so their scores are
no longer comparable. Making the schema part of the immutable scorer config
(the same shape every other scorer already uses — `contains.value`,
`json_logic.expression`) freezes it per Eval and keeps runs comparable; the
agent's `output_schema` is used only when the scorer omits `schema`, as a
convenience. An `output_schema` scorer whose schema resolves from **neither**
source is rejected `400` at Eval-create (best-effort — the agent's schema is
mutable) **and** re-checked at run-start (authoritative), naming the field.

**Decision (2026-07): an `output_schema` scorer additionally requires the agent
to carry *some* `output_schema` — a scorer-supplied `schema` alone is rejected
`400`.** The platform only produces `output.object` when the **agent** has an
`outputSchema`: `buildStructuredOutput(typedAgent.outputSchema)` is what
constrains the model, and `object` is set only under
`typedAgent.outputSchema ? … : undefined` (`agentNonStreamGeneration.ts`, both
the first-pass and tool-continuation sites). A scorer `schema` against an agent
with no `output_schema` would therefore leave `object` permanently absent and —
under the "missing `object` scores 0" rule below — score **0 on every item, on
every run**: a fabricated regression signal, which is the exact failure this
module exists to prevent. The two schemas play distinct roles and neither
substitutes for the other: the **agent's** schema decides *whether* structured
output is produced at all, the **scorer's** schema is the frozen criterion that
output is judged against. Rejected `400` at Eval-create and re-checked at
run-start, naming the agent's missing `output_schema`.

**Decision (2026-07): scorers read the generation's two output channels
explicitly.** `createGeneration` returns `output.content` (the final text) and,
for an agent with an `output_schema`, `output.object` (the structured output the
platform already parsed and validated). Text scorers (`exact_match`, `contains`,
`llm_judge`, and `json_logic`'s `output` var) read `output.content`; the
`output_schema` scorer validates `output.object` (never re-parses the text). A
missing `object` on an otherwise `completed` generation (the model returned no
structured output) scores 0.

**Decision (2026-07): a non-`completed` generation is an item-level *error*,
never a score of 0.** `createGeneration` is typed
`Promise<GenerationResult | ReadableStream>` and its `status` is
`'completed' | 'requires_action'` — a `requires_action` result (an agent with
client-side tools pausing for tool outputs) carries `requiredAction` and **no**
`output` at all. Scoring that 0 would report a *behavioral* regression for what
is really an un-evaluable target. Eval runs pass `stream: false` (so the
`ReadableStream` arm is unreachable) and record a `requires_action` result in
`EvalResult.error` with `generation_id` still linked (the generation exists) —
counted in `erroredCount`, excluded from `aggregateScores`, never scored. Agents
whose tool set forces a client round-trip stay un-evaluable until a later phase
can supply synthetic tool outputs; that is out of scope here.

## Execution

Starting a run snapshots the dataset's items and creates one **real agent
generation per item** through the existing `createGeneration` machinery
(`createGeneration({ agentId, messages, stream: false })`, one call per item) —
the run exercises the agent's true instructions, tools, model, and knowledge,
and each `EvalResult` links its `generation_id`/trace for drill-down.

**Decision (2026-07): `wait: true` means "run synchronously or fail" — never
silently truncate or downgrade.** A sync run over a dataset larger than the
sync item cap (25) is rejected `400` naming the cap, rather than scoring a
partial subset (which would read as a complete pass/fail over the whole
dataset). The over-cap `400` is stable across phases: `wait: true` never becomes
async, so the same request keeps returning `400` once the queue lands.

**Decision (2026-07): `wait` is *required* in Phase 1 — there is no default.**
Forward-compatibility depends on this, and it does not come for free.
`orchestrations.yaml` declares `wait` with `default: false`, and Phase 2 below
answers an async request with `status: "queued"`. Had Phase 1 shipped `wait`
optional-defaulting-`true`, a caller who omits it would get a synchronous scored
run today and a bare `queued` run the day the queue lands — a silent breaking
change to a public response shape, in the one field callers gate deployments on.
Requiring the field in Phase 1 means `wait: false` returns `400` (async
unavailable, naming the phase), and Phase 2 flips that same request to `queued`
**additively**. A `default: false` may then be introduced, matching
orchestrations, without any existing caller changing behavior.

**Decision:** async runs enqueue **one task per dataset item on the existing
`RunTask` queue** (the [durable orchestration queue](../packages/website/docs/modules/orchestrations.md#durable-background-execution),
new `kind: eval_item`) rather than inventing a second worker — leases,
redelivery, and concurrency limits come for free, and the unique
`(evalRunId, datasetItemId)` constraint makes redelivered items no-ops.

**Decision:** eval generations are attributed with `source: eval` at the
usage-metering choke point ([usage module doc](../packages/website/docs/modules/usage.md))
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
`json_logic`, and `output_schema` scorers. Sync runs persist the `EvalRun` as
`running`, execute inline, and set the terminal status before returning (no
`queued` state — that arrives with the Phase 2 queue).

**Known limitation (accepted):** a client that disconnects mid-run leaves the
`EvalRun` row `running` indefinitely — Phase 1 has neither the Phase 2 lease
reaper nor the `cancel` route in scope, and nothing retries or cleans the row.
The debt is deliberately visible (the row is queryable with `started_at` set and
`finished_at` null) and cheap to repay: the Phase 2 reaper covers it with no
schema change.

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
- Text scorers (`exact_match`, `contains`) read `output.content`; the
  `output_schema` scorer validates `output.object` and scores 0 when it is
  absent — asserted with `mockCreateGeneration` returning each output channel
- An `output_schema` scorer whose `schema` is omitted **and** whose agent has no
  `output_schema` is rejected `400` at Eval-create and again at run-start; a
  scorer-supplied `schema` is used verbatim even when the agent has one
- An `output_schema` scorer against an agent with **no** `output_schema` is
  rejected `400` at Eval-create and again at run-start, whether or not the
  scorer supplies its own `schema` (without an agent schema the platform emits
  no `object`, so every item would score 0)
- A `requires_action` generation marks the item errored — `error` set,
  `errored_count` incremented, the item excluded from `aggregate_scores` — and
  does **not** score 0; asserted with `mockCreateGeneration` returning
  `status: "requires_action"`
- A `wait: true` run over a dataset larger than the 25-item sync cap returns
  `400` naming the cap (no partial scoring)
- `wait` is required: omitting it returns `400`, and `wait: false` returns `400`
  naming async as unavailable until Phase 2
- **Pins the one unverified premise:** the test that asserts `output.object` for
  a schema-bound agent also asserts `output.content` is non-empty, so "text
  scorers still work against an agent with an `output_schema`" becomes a test
  rather than an assumption. If `content` proves empty under AI SDK structured
  output, `exact_match`/`contains` must instead be rejected `400` against
  schema-bound agents
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
- Async run: `POST .../runs` with `wait: false` returns `status: "queued"`
  immediately — the same request that returned `400` in Phase 1, so the change
  is additive; `wait` may now take `default: false`, matching
  `orchestrations.yaml`. A redelivered item task inserts no duplicate
  `EvalResult` (unique `(eval_run_id, dataset_item_id)` asserted, count == 1)
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
  [metering choke point](../packages/website/docs/modules/usage.md#coverage) records it

### Phase 3 — Scheduled Evals + Formation Resource ❌ Not started

Schedules integration (cron [triggers](../packages/website/docs/modules/triggers.md)) so an eval
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

## Decision log

Recorded per `.claude/rules/open-questions.md`: every open question raised while
scoping Phase 1, how it was resolved, and what was actually checked. Code
references are to `packages/server/src`.

```txt
Q: Should the `output_schema` scorer validate against the agent's live
   `output_schema`, or carry its own?
A: Its own, agent's as fallback — resolved by long-term (durability ladder: an
   immutable scorer config is a frozen criterion, a live agent field is not);
   checked: every other scorer already inlines its criterion
   (`contains.value`, `json_logic.expression`), and `Eval.scorers` is JSONB
   written at create.

Q: Must the agent also carry an `output_schema` when the scorer supplies one?
A: Yes, `400` otherwise — resolved by pareto (removes a silent all-zero
   scoring mode, costs nothing else); checked:
   `agentNonStreamGeneration.ts` sets `object` only under
   `typedAgent.outputSchema ? … : undefined` at both generation sites and
   passes only the agent's schema to `buildStructuredOutput`, so no agent
   schema means no `object` on any item, ever.

Q: Do scorers read the generation's text or its structured object?
A: Both, explicitly — text scorers read `output.content`, `output_schema`
   reads `output.object` — resolved by pareto (consumes what the platform
   already parsed; strictly better than re-parsing text and worsens nothing);
   checked: `GenerationResult.output` in `agentGenerationHelpers.ts` declares
   `content`, `finishReason`, `responseMessages?`, and `object?`.

Q: How does a scorer treat a generation with no `output`?
A: `requires_action` → item error; `completed` with no `object` → 0 —
   resolved by long-term (pattern hygiene: an unsupported capability must not
   read as a behavioral regression); checked: `createGeneration` is typed
   `Promise<GenerationResult | ReadableStream>` with
   `status: 'completed' | 'requires_action'`, and the `requires_action` arm
   carries `requiredAction` in place of `output`.

Q: What does a `wait: true` run do when the dataset exceeds the sync cap?
A: `400` naming the cap — resolved by long-term (debt containment: a partial
   subset reported as a whole-dataset verdict is invisible debt in the one
   number callers gate on); checked: nothing in Phase 1 scope aggregates over
   a subset, so no caller depends on truncation.

Q: Is `wait` optional in Phase 1?
A: Required, no default — resolved by long-term (the alternative silently
   changes a public response shape when the queue lands); checked:
   `orchestrations.yaml` declares `wait` with `default: false`, and this PRD's
   Phase 2 criteria answer an async request with `queued`.

Q: Does a sync run ever persist `queued`?
A: No, `running` → terminal — resolved by pareto (a state no code can reach or
   observe is dead surface); checked: Phase 1 scope contains no queue, so
   nothing could transition a row out of `queued`.
```

### Forwarded, not self-resolved

Two items fall into the gate's non-self-resolvable classes and are recorded here
as recommendations rather than settled decisions:

- **Public API contract (high-risk class).** The scorer `schema` field, the
  required `wait` field, and every `400` above are public contract surface. The
  gate routes public API contracts to a human regardless of which test appears
  to resolve them, so these need sign-off before the Phase 1 implementation
  freezes them into the OpenAPI spec, SDK, and CLI.
- **Unverifiable premise.** Whether a schema-bound agent's `output.content`
  still carries the final text under AI SDK structured output could not be
  checked (package dependencies are not installed in the deciding session, and
  no existing test asserts `content` and `object` together). Phase 1 acceptance
  criteria pin it with a test instead of assuming it; the fallback if it proves
  empty is stated there.

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
- **Queue dependency** — Phase 2 async execution rides the shipped `RunTask`
  queue (see [Durable Background Execution](../packages/website/docs/modules/orchestrations.md#durable-background-execution)). Degraded-mode fallback
  (in-process loop) is deliberately not built to avoid a second execution
  path.
- **Flaky non-determinism** — agents are stochastic; a red run may be
  variance, not regression. Aggregate scores over datasets (not single items)
  and thresholds below 1.0 are the intended mitigation; seed/temperature
  pinning is out of scope.
