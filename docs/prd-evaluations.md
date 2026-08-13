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
| passThreshold | DECIMAL     | NULL; 0–1; run `passed` iff pass rate ≥ threshold (see [Pass semantics](#pass-semantics)) |
| createdAt / updatedAt | TIMESTAMP | NOT NULL                                            |

Indexes: unique `(projectId, name)`, `(projectId)`, `(agentId)`.

### EvalRun (`evrun_`)

| Column          | Type        | Constraints                                                        |
| --------------- | ----------- | ------------------------------------------------------------------ |
| id              | INTEGER     | PK                                                                 |
| publicId        | VARCHAR(32) | UNIQUE, `evrun_` prefix                                            |
| evalId          | INTEGER     | FK → Eval, NOT NULL                                                |
| agentVersion    | INTEGER     | NOT NULL; the one agent version every item ran against (see [Version pinning](#version-pinning)) |
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
| datasetItemId | INTEGER     | FK → DatasetItem, NULL, ON DELETE SET NULL (see [Item snapshot](#item-snapshot)) |
| input         | JSONB       | NOT NULL; frozen copy of the item's `input` at run time           |
| expectedOutput | TEXT       | NULL; frozen copy of the item's `expected_output` at run time     |
| generationId  | INTEGER     | FK → Generation, NULL (null when the generation itself errored)   |
| output        | TEXT        | NULL; the agent's final output text (redacted by generation purge — see [Retention](#retention--erasure)) |
| scores        | JSONB       | NOT NULL; `[{scorer, score, passed, reasoning?}]` per scorer      |
| passed        | BOOLEAN     | NOT NULL; AND over per-scorer `passed`                            |
| error         | TEXT        | NULL; item-level failure reason                                   |
| createdAt     | TIMESTAMP   | NOT NULL                                                          |

Indexes: `(evalRunId)`, unique `(evalRunId, datasetItemId)` — one result per
item per run, which also makes queue redelivery idempotent. (The column is
always populated at insert time — items are only deletable *after* a run, and
PostgreSQL unique indexes ignore NULLs, so a later `SET NULL` cannot collide.)

## Scorers

`Eval.scorers` is an extensible discriminated union on `type` (snake_case in
REST bodies per the case convention):

| `type`          | Config                                                          | Score                                        |
| --------------- | --------------------------------------------------------------- | -------------------------------------------- |
| `exact_match`   | — (compares output to `expected_output`, trimmed)               | 0 or 1                                       |
| `contains`      | `value`, `case_sensitive` (default false)                       | 0 or 1                                       |
| `json_logic`    | `expression` — JSON Logic over `{input, output, object, expected, item.metadata}` (`object` is the structured output, when the agent has an `output_schema`) | truthy → 1, falsy → 0              |
| `output_schema` | `schema` (optional JSON Schema); falls back to the agent's `output_schema`, which must be set either way | 0 or 1 — validates the generation's structured `object` output |
| `llm_judge`     | `ai_provider_id`, `model`, `prompt` with `{{input}}` / `{{output}}` / `{{expected}}` slots, `pass_threshold` (required, 0–1) | 0–1 + `reasoning`; `passed` iff score ≥ its `pass_threshold` |

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

### Pass semantics

**Decision (2026-08, owner sign-off): run-level `passed` gates on the pass
rate, never on a pooled mean.** Three levels, each derived from the one below:

1. **Per scorer, per item** — a binary scorer passes iff its score is 1; an
   `llm_judge` scorer passes iff its score ≥ the scorer's own **required**
   `pass_threshold`. Every scorer therefore produces a well-defined `passed`
   without special-casing downstream.
2. **Per item** — `EvalResult.passed` is the AND over its per-scorer `passed`
   (as already specified in the data model).
3. **Per run** — `EvalRun.passed` is `null` when the Eval has no
   `pass_threshold`; otherwise it is true iff the **pass rate** — passed items
   over non-errored items — is ≥ `Eval.pass_threshold`.

The rejected alternative, "mean of all scores ≥ threshold" (this PRD's original
wording), pools 0/1 binaries with 0–1 judge fractions into a unit-less number
whose meaning shifts whenever a scorer is added — a gate value nobody can
reason about. `aggregate_scores` still reports per-scorer means and pass rates
(plus baseline deltas), so the continuous signal is not lost; it just does not
gate.

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
`output_schema` scorer validates `output.object` (never re-parses the text), and
`json_logic` additionally exposes it as the `object` var so value-level
assertions over structured output (`object.category == expected`) need no text
re-parsing either — absent when the agent has no `output_schema`. A
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

Phase 1 sync runs execute items **sequentially** — the 25-item cap bounds the
worst case, and a run of real generations can take minutes, which callers of
`wait: true` must expect. Bounded parallelism is an additive later optimization
with no contract change; async runs get concurrency from the queue.

### Item snapshot

**Decision (2026-08, owner sign-off): the run freezes what it ran against —
each `EvalResult` carries a copy of its item's `input` and `expected_output`
taken at run time, and `dataset_item_id` becomes a nullable
`ON DELETE SET NULL` link.** This is the same argument that froze the
`output_schema` scorer's `schema` into the Eval config, applied to the data:
items have full CRUD, so without a frozen copy, editing or deleting items
between two runs silently makes their scores incomparable — and a baseline
delta would report dataset drift as agent regression, the exact fabricated
signal this module exists to prevent. With the copy on the result row, results
are self-contained forever, items stay freely editable and deletable (deleting
one no longer collides with a NOT NULL FK or cascades history away), and no
separate snapshot model is needed.

Baseline deltas are computed **only over items present in both runs** (matched
by `dataset_item_id`); when the two runs' item sets diverge, the divergence is
flagged in `aggregate_scores` (compared/added/removed counts) so a delta over a
shifted dataset is never presented as a clean comparison.

### Version pinning

**Decision (2026-08, owner sign-off): a run resolves ONE agent version at
run-start, stamps it on `EvalRun.agent_version`, and every item runs against
it.** Without pinning, the served-version machinery would sabotage the run:
release assignment keys on the session's actor, an eval generation has no
session, and a null key gets a **random bucket per generation**
(`releaseAssignment.ts`) — so under an active canary, one run would blend two
versions into a single score, and its baseline delta would be noise.

`POST /evals/{eval_id}/runs` accepts an optional `agent_version` (any archived
version number) to name the version under test — this is how the promotion gate
in `docs/prd-agent-versions.md` evals a canary before promoting it. When
omitted, the run uses the agent's live draft config (stamping its current
version), or the active release's **stable** version when a release is in
effect — never a random assignment. An `agent_version` with no archived config
is rejected `400` at run-start.

### Retention & erasure

**Decision (2026-08, owner sign-off): generation purge cascades to eval
results; datasets are operator-owned fixtures that purge never touches.** The
platform's content purge redacts a generation's stored content — but
`EvalResult.output` is a copy of that content on another table, and a purge
that leaves copies behind is not a purge. So purging a generation (directly or
via its trace) also redacts the `output` of any `EvalResult` linking it, the
same redaction semantics as the generation row; scores, `passed`, and the
frozen `input`/`expected_output` survive, so run aggregates remain meaningful.

Dataset items sit on the other side of the line, including items curated
`from-generation`: they are deliberate, operator-owned **test fixtures**, and
erasing the source generation does not delete or mutate them — a test suite
must not silently stop being runnable because of an unrelated erasure request.
The `from-generation` route's documentation must state this explicitly: the
copy is deliberate, and an erasure request covering the source content requires
the operator to delete the curated item themselves. The module doc carries both
halves of this posture.
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
against the baseline — computed over the item intersection, with divergence
flagged (see [Item snapshot](#item-snapshot)) — and `passed` is computed from
`pass_threshold` per [Pass semantics](#pass-semantics). Webhook
events `eval_run.completed` and `eval_run.failed` fire through the existing
webhooks module with `{eval_id, eval_run_id, passed, aggregate_scores}` —
this event + verdict pair is the promotion gate consumed by
`docs/prd-agent-versions.md`.

## REST API

Snake_case bodies; MCP tools and SDK/CLI derive from the OpenAPI spec
(`packages/server/src/rest/openapi/v1/evaluations.yaml`) via `soatTools.ts`.

| Method | Path                                                    | Description                                    | Phase |
| ------ | ------------------------------------------------------- | ---------------------------------------------- | ----- |
| POST/GET | `/api/v1/datasets`                                    | Create / list datasets (`project_id` filter)   | 1 |
| GET/PUT/DELETE | `/api/v1/datasets/{dataset_id}`                 | Get / update / delete a dataset                | 1 |
| POST/GET | `/api/v1/datasets/{dataset_id}/items`                 | Add / list items                               | 1 |
| PUT/DELETE | `/api/v1/datasets/{dataset_id}/items/{item_id}`     | Update / delete an item                        | 1 |
| POST   | `/api/v1/datasets/{dataset_id}/items/from-generation`   | Curate an item from a generation               | 2 |
| POST/GET | `/api/v1/evals`                                       | Create / list evals                            | 1 |
| GET/PUT/DELETE | `/api/v1/evals/{eval_id}`                       | Get / update / delete an eval                  | 1 |
| POST   | `/api/v1/evals/{eval_id}/runs`                          | Start a run (`wait`, `baseline_run_id`, optional `agent_version`) | 1 (`baseline_run_id` deltas: 2) |
| GET    | `/api/v1/evals/{eval_id}/runs`                          | List runs                                      | 1 |
| GET    | `/api/v1/evals/{eval_id}/runs/{run_id}`                 | Run status + aggregate scores + deltas         | 1 |
| GET    | `/api/v1/evals/{eval_id}/runs/{run_id}/results`         | Per-item results (paginated)                   | 1 |
| POST   | `/api/v1/evals/{eval_id}/runs/{run_id}/cancel`          | Cancel a queued/running run                    | 2 |

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

### Phase 1 — Datasets + Evals + Sync Deterministic Runs ✅ Shipped

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
  scores for all four scorer types, and run `passed` derived from
  `pass_threshold` as a **pass rate** over non-errored items
  ([Pass semantics](#pass-semantics))
- Each `EvalResult` carries the frozen `input`/`expected_output` copies;
  editing then deleting a dataset item **after** a run leaves the run's results
  intact and readable (`dataset_item_id` nulled, copies unchanged)
- `EvalRun.agent_version` is stamped on every run; a run with `agent_version`
  naming an archived version executes against that config
  (`mockCreateGeneration` asserted via the served instructions), an unknown
  version returns `400`, and a run against an agent with an active release
  pins the whole run to one version — never per-item random assignment
- Purging a linked generation redacts the `EvalResult.output` of its result
  row; scores and the frozen input survive
  ([Retention & erasure](#retention--erasure))
- `json_logic` expressions can assert over the `object` var for a schema-bound
  agent, and `object` is absent (not an error) for an agent without an
  `output_schema`
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

### Phase 2 — LLM Judge + Async Queue + Baselines 🟡 Shipped, minus curation

`llm_judge` scorer; async runs on a dedicated eval queue; `baseline_run_id`
deltas; `eval_run.completed`/`.failed` webhooks; `cancel`; a lease reaper;
`source: eval` / `eval_judge` usage attribution.

**Deviation from the async-queue decision above.** The PRD specified one task per
item on the existing `orchestration_run_tasks` queue (`kind: eval_item`), on the
grounds that "leases, redelivery, and concurrency limits come for free." That
premise does not hold: the table carries a NOT NULL FK to `orchestration_runs`,
and its claim is a SQL join over tasks → runs → projects that reads each
project's `max_concurrent_runs`. An eval item has no orchestration run to join
through, so sharing the table would have meant nullable FKs on a shipped hot
path, a rewritten claim query, a `ClaimedTask` shape that no longer names what it
points at, and an SQS driver silently unable to honour the limit the decision was
banking on. Phase 2 therefore uses its own `EvalRunTask` table and shares the
mechanics that actually matter — claim, lease, redelivery, batching, the timer —
through `createSweep` / `createScheduler`, the same seam the platform's other
seven pollers already use. That is reuse of the abstraction rather than of the
table, and it satisfies the decision's real intent ("rather than inventing a
second worker") without editing the orchestration runtime.

**`from-generation` curation is deferred, not shipped.** The criterion below
assumes the platform can read a past generation's input messages and output text.
It cannot: neither is persisted in any platform-owned shape — `Generation` has no
messages or output column, and `PURGED_GENERATION_CONTENT` covers only
`metadata` / `error` / `extraction` / `pendingState`. Both live solely inside the
AI SDK `steps` blob written to the trace's file, which the platform only ever
*writes*. Building the route would mean either (a) the platform's first reader of
that blob, keyed on an SDK-internal shape, yielding empty items for
zero-retention and purged generations, or (b) persisting request messages in a new
content column — a privacy-class decision (it stores end-user prompts) that the
open-questions gate always forwards. Forwarded for a product call rather than
resolved.

**Acceptance criteria:**

- `llm_judge` renders `{{input}}`/`{{output}}`/`{{expected}}` into the prompt
  and parses `{score, reasoning}` — asserted against a local fake
  OpenAI-compatible server (tests.md pattern); a malformed judge response
  marks the item errored, not the run failed; a judge config without
  `pass_threshold` is rejected `400` at Eval-create, and per-item `passed`
  flips exactly at the threshold ([Pass semantics](#pass-semantics))
- Async run: `POST .../runs` with `wait: false` returns `status: "queued"`
  immediately — the same request that returned `400` in Phase 1, so the change
  is additive; `wait` may now take `default: false`, matching
  `orchestrations.yaml`. A redelivered item task inserts no duplicate
  `EvalResult` (unique `(eval_run_id, dataset_item_id)` asserted, count == 1)
- Two additions the phase needed beyond the original list, both covered:
  **settling is atomic** (a conditional `UPDATE` on `finished_at IS NULL` claims
  the right to finalize, so concurrent workers draining a run's last items fire
  `eval_run.completed` exactly once — a gate that receives a verdict twice can
  act twice), and **`cancel`** drops outstanding tasks and settles the run while
  keeping already-scored results and publishing no partial aggregate
- Run with `baseline_run_id` returns per-scorer `delta` values equal to
  (current mean − baseline mean) within float tolerance, computed over the item
  intersection with divergence counts flagged when the item sets differ
  ([Item snapshot](#item-snapshot)); a baseline from a different Eval returns
  `400`
- `eval_run.completed` fires exactly once per terminal run with the documented
  payload, asserted via a webhook test receiver; `eval_run.failed` on run
  failure
- ⏭️ **Deferred** — `from-generation` copies the generation's input messages and
  output into a new item with `source_generation_id` set; `404` for a generation
  outside the caller's project; the operation's spec description carries the
  fixture-ownership warning from [Retention & erasure](#retention--erasure).
  Blocked on where that content would come from — see the deviation note above
- Eval generations carry `source: eval` attribution, asserted where the
  [metering choke point](../packages/website/docs/modules/usage.md#coverage) records it

### Phase 3 — Scheduled Evals + Formation Resource ✅ Shipped

Schedules integration (cron [triggers](../packages/website/docs/modules/triggers.md)) so an eval
run fires on a cron cadence; `eval`, `dataset`, and `dataset_item` formation
resource types.

**Two deviations from the sketch above, both widening it.**

*A third resource type.* The sketch named `eval` and `dataset`. A dataset with no
items is not runnable — a run over an empty dataset is a `400` by design — so a
template that can declare only the two produces a stack whose eval can never
execute. The items therefore ship as their own `dataset_item` type, the
`memory` / `memory_entry` shape the platform already uses for parent-plus-fixtures.
The alternative — an `items` array inside `DatasetResourceProperties` — would make
the formation the owner of the whole item set, so an apply would delete items
curated through the API (exactly the fixtures `source_generation_id` exists to
mark) and churn item ids on every reconcile.

*No `evaluationsFormationModule.ts`.* The sketch named one module for all of it;
`defineFormationModule` is per resource type (the schema name is **derived** from
the type), so this is three small modules — `datasetsFormationModule`,
`datasetItemsFormationModule`, `evalsFormationModule` — each declaring only its
property→lib-arg mapping. Writing one module that switched on type would have
reintroduced the skeleton that factory exists to delete.

**Acceptance criteria:**

- A schedule targeting an Eval starts a run per fire; the run records its
  schedule origin in `EvalRun.trigger_id` (denormalized, like
  `OrchestrationRun.triggerId`, so a deleted trigger cannot rewrite a past
  measurement's provenance)
- The firing always starts a **queued** run: a suite is one real generation per
  item with no cap, so a cron tick never blocks on it
  (`.claude/rules/sync-async.md`). The firing record carries the `evrun_…` to poll
- Binding a trigger to an eval requires `evaluations:RunEval` on top of
  `triggers:CreateTrigger` — the same no-privilege-escalation guard the other
  three target types use; a caller without it gets `403`
- `Dataset`/`DatasetItem`/`EvalResourceProperties` added to `formations.yaml`;
  unknown-field and required-field template validation rejects with `400`
  (formationSpecLoader allowlist), and the derived-schema-name contract test
  covers the three new types automatically
- `update-formation` round-trip: a template declaring an eval creates it,
  changing `pass_threshold` updates it in place (same physical id), removal
  deletes it while leaving the dataset it referenced
- `dataset_id` is immutable on a `dataset_item`: a template that moves an item
  is rejected rather than silently applying the rest of its properties
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

Q: Should `json_logic` expressions see the structured `object` output?
A: Yes, as an `object` var — resolved by pareto (additive before the contract
   freezes; value-level assertions otherwise force text re-parsing); checked:
   `GenerationResult.output` declares `object?` and `evaluateLogic` takes an
   arbitrary data context, so it is one more key in the vars object.

Q: Sync-run execution — sequential or parallel?
A: Sequential in Phase 1, duration documented — resolved by long-term
   (parallelism is additive later with zero contract change; the 25-item cap
   bounds the worst case); checked: nothing in Phase 1 scope depends on run
   latency.

Q: What about write-capable tools during eval runs?
A: Documented risk + operator guidance, fix deferred to the synthetic-outputs
   phase — resolved by pareto (a named risk worsens nothing; a tool-stub mode
   now would contradict the real-generation premise this PRD already settled);
   checked: no tool-stub seam exists in `agentToolResolver`, so building one is
   its own initiative, not a criterion here.

Q: `cancel` is in the REST table but out of Phase 1 — confusing?
A: Phase column added to the endpoint table — resolved by pareto; doc clarity
   only.
```

Four further questions were forwarded (2026-08) as high-risk classes — public
API contract, privacy — and decided by the owner; each is recorded as a
**Decision (2026-08, owner sign-off)** block above:

- **Item snapshot** — results freeze `input`/`expected_output`;
  `dataset_item_id` nullable `ON DELETE SET NULL`; deltas over the
  intersection ([Item snapshot](#item-snapshot)).
- **Version pinning** — one version per run, stamped on
  `EvalRun.agent_version`, optional `agent_version` selector; checked this
  session: `resolveAssignmentKey` returns null without a session and a null
  key gets a random bucket per generation (`releaseAssignment.ts`), so an
  unpinned run under a canary blends versions.
- **Retention & erasure** — generation purge cascades to `EvalResult.output`;
  curated dataset items are operator-owned fixtures
  ([Retention & erasure](#retention--erasure)); checked this session:
  `purgeGenerationContent` redacts only the generation row's own columns.
- **Pass semantics** — pass-rate gating, required `llm_judge.pass_threshold`
  ([Pass semantics](#pass-semantics)).

### Forwarded, not self-resolved

Two items fall into the gate's non-self-resolvable classes and are recorded here
as recommendations rather than settled decisions:

- **Public API contract (high-risk class).** The scorer `schema` field, the
  required `wait` field, and every `400` above are public contract surface. The
  gate routes public API contracts to a human regardless of which test appears
  to resolve them, so these need sign-off before the Phase 1 implementation
  freezes them into the OpenAPI spec, SDK, and CLI. (The four 2026-08 questions
  listed at the end of the decision log received that sign-off; the remaining
  Phase 1 contract surface still needs its pre-implementation pass.)
- **Unverifiable premise.** Whether a schema-bound agent's `output.content`
  still carries the final text under AI SDK structured output could not be
  checked (package dependencies are not installed in the deciding session, and
  no existing test asserts `content` and `object` together). Phase 1 acceptance
  criteria pin it with a test instead of assuming it; the fallback if it proves
  empty is stated there.

### Phase 3 decisions

```txt
Q: Should a trigger firing run the eval inline (like the orchestration target)
   or queue it?
A: Queue it — resolved by long-term (durability ladder + the shipped
   sync/async rule); checked: `.claude/rules/sync-async.md` requires background
   default for work that outlasts a request, an eval has no item cap on the
   queued path (`SYNC_ITEM_CAP` applies only to `wait: true`), and a scheduler
   tick holding a request open for N real generations is the failure that rule
   names. The firing record carries the run id, so nothing is lost.

Q: Does the run's schedule origin belong in an FK to `Trigger` or a
   denormalized id?
A: Denormalized `VARCHAR(32)` — resolved by pareto; improves nothing else's
   cost and matches `OrchestrationRun.triggerId` verbatim (pattern hygiene);
   checked: an FK with `ON DELETE SET NULL` would erase a finished run's
   provenance when the trigger is deleted, and a run is a historical
   measurement.

Q: Should dataset items be an `items` array inside the dataset resource, or
   their own `dataset_item` resource type?
A: Their own type — resolved by long-term (pattern hygiene + debt containment);
   checked: `memory`/`memory_entry` is the shipped precedent for the same
   parent-plus-fixtures shape, item ids stay stable across applies, and an
   items array would make an apply delete API-curated items, which is data loss
   in the one place (`source_generation_id`) the module marks as deliberate.

Q: Should `dataset_id` be mutable on a `dataset_item` template?
A: No, rejected with a `400` — resolved by pareto; the alternative (ignore the
   declared value) reports success for an apply that did not happen; checked:
   the lib addresses an item through its parent for authorization, so a move
   has no single-call form either.
```

## Risks

- **Eval runs spend real money** — every item is a real generation, and
  `llm_judge` doubles the calls. Mitigated by `source: eval` attribution,
  usage-metering thresholds, the sync-run item cap, and queue concurrency
  limits; still, a 10k-item dataset is a footgun until per-run item limits are
  tuned.
- **Eval runs have real side effects** — an agent with a write-capable `http`
  or `mcp` tool executes N real writes per run, nightly under Phase 3
  schedules. There is no tool-stub mode, deliberately (real generations are the
  module's premise); the operator guidance — stated in the module doc — is to
  point an eval'd agent's tools at a staging target. Synthetic tool outputs
  (the deferred client-tool phase) are the eventual seam for side-effect-free
  runs.
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

