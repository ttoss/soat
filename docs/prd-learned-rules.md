# PRD: Learned Rules (Feedback Loop)

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G6).
> Captures from [prd-approvals.md](./prd-approvals.md) resolution paths;
> injects through the context assembler in
> [prd-knowledge-packages.md](./prd-knowledge-packages.md). Reuses the
> embedding nearest-neighbor machinery from
> [prd-memories.md](./prd-memories.md).

## Implementation Phases

### Phase 1 — Candidate Capture ❌ Not started

**Goal:** No human correction is lost: every intervention automatically
becomes a reviewable candidate rule with full context.

**Deliverables:**

- `CandidateRule` model (see [Data Model](#data-model))
- Capture hooks:
  - **Rejected approval** — the mandatory rejection reason becomes the
    candidate text ([prd-approvals.md](./prd-approvals.md))
  - **Edit-then-approve** — the argument diff becomes the candidate ("human
    changed X to Y in this situation")
  - **Explicit correction** — `POST /api/v1/candidate-rules` (and the derived
    MCP tool) for corrections arriving through chat surfaces
- Each candidate embeds its text (same embedding pipeline as memory entries)
  and links its provenance: project, agent, run, source approval/exception

**Unlocks:** The raw material of the feedback loop accumulates from day one —
capture cannot be retrofitted.

### Phase 2 — Recurrence Detection ❌ Not started

**Goal:** Repeated corrections surface themselves instead of relying on
someone rereading the queue.

**Deliverables:**

- Clustering pass on the scheduler tick (nightly): nearest-neighbor search of
  new candidates against existing candidates and promoted rules, reusing the
  memory module's similarity machinery
- **Similarity metric (decision):** embedding-based **cosine similarity** via
  pgvector — the platform already has pgvector and the embeddings module, so
  no new machinery. The embedded text is the candidate's `text` field verbatim
  (rejection reason, edit diff summary, or manual correction), compared
  against other candidates' `text` embeddings and promoted rules' `text`
  embeddings (both tables carry an `embedding` column)
- **Threshold (decision):** two texts belong to the same cluster when cosine
  similarity ≥ **0.85** (default), configurable per deployment via
  `LEARNED_RULES_SIMILARITY_THRESHOLD`. Rationale: 0.85 sits between the
  memories module's `duplicate_threshold` (0.95 — too strict, misses
  paraphrased corrections) and its `shortlist_threshold` (0.60 — too loose,
  merges unrelated corrections)
- Similar candidates merge into a cluster (`occurrences` counter, exemplar
  text); `occurrences >= N` (configurable, default 3) sets
  `promotion_suggested = true`
- Candidates matching an already-promoted rule are auto-linked to it rather
  than re-flagged (signal that the rule may not be working — surfaced on the
  rule)

**Unlocks:** "This correction has happened 4 times across 3 runs" as a
queryable fact.

### Phase 3 — Promotion Lifecycle ❌ Not started

**Goal:** A human curates candidates into versioned, scoped rules.

**Deliverables:**

- `LearnedRule` model; promotion endpoint takes the final rule text (usually
  edited from the candidate), a **scope**, and records
  `promoted_from`/`promoted_by`
- Scopes: `global` (all projects) and `project` (one project). Rules are
  versioned per scope; updating a rule creates a new version, never mutates
  history — the prior document is archived to `LearnedRuleVersion`
  (see [Data Model](#learnedruleversion)), the same pattern guardrails ships
  as `GuardrailVersion`
- Candidate lifecycle: `open → promotion_suggested → promoted | dismissed`
  (dismissal takes a reason)
- **Cross-project isolation:** candidates and project-scoped rules never
  leak between projects; only explicitly promoted `global` rules are shared.
  Tenancy tests over both tables

**Unlocks:** A curation flow (UI or PR-based — out of scope here) driven
entirely through the API.

### Phase 4 — Context Injection ❌ Not started

**Goal:** A promoted rule demonstrably changes the next matching run.

**Deliverables:**

- The [context assembler](./prd-knowledge-packages.md) pulls active
  `LearnedRule`s whose scope matches the run's project, ordered
  `global → project` (most specific **last**, so it wins on conflict), into
  the dedicated learned-rules layer of the assembly
- Rules are injected fenced as reference data (never `system` role),
  consistent with the knowledge injection hygiene rule
- Acceptance test: reject an approval with a reason → promote the candidate →
  the next run's assembled context contains the rule (and the previous run's
  did not)

**Unlocks:** The loop closes — human corrections change agent behavior without
a redeploy.

## Overview

[Memories](./prd-memories.md) store *facts the agents learn about the world*.
Learned rules store *corrections humans make to agent behavior* — "never do X
when Y", "always confirm Z first" — with a lifecycle: captured automatically,
clustered for recurrence, **promoted by a human**, versioned, scoped, and
injected into future context.

Promotion is deliberately human-curated. Automatic promotion of free-text
corrections into standing instructions is an unforced error class; SOAT
provides the queue, the clustering signal, and the injection — a human owns
the judgment.

### Why a module, not a memory kind

A skeptic's cut: couldn't this be `kind: correction` on memory entries? No —
the *lifecycle* is what justifies the module, not the storage shape. Memories
are agent-written facts with an automatic write path; learned rules are
human-gated behavioral doctrine with promotion, dismissal-with-reason,
append-only versioning, `global` scope crossing project boundaries, and audit
provenance from rule back to the originating approval. None of that fits the
memories write path, and forcing it in would blur the platform's context
boundary: **memories = facts the agents learn about the world; learned rules
= corrections humans make to agent behavior**. Docs and API surfaces must
keep that sentence sharp — it is the answer to "where does this piece of
guidance belong?" across instructions, knowledge, memories, packages, and
rules.

### Soft rules and the guardrail graduation path

A learned rule is **soft**: injected context the model is expected — but not
forced — to follow. Enforcement is not this module's job. The graduation path
for a constraint that must *never* be violated is **hard**: encode it as a
guardrail `deny` ([guardrails](../packages/website/docs/modules/guardrails.md)),
so the action is refused upstream and never reaches the approval queue again.

Two signals feed that graduation decision:

- **Recurring rejected re-proposals** from approvals (admitted with
  `previous_item_id` per [prd-approvals.md](./prd-approvals.md) decision 2) —
  recurrence detection happens here (Phase 2 clustering), not in approvals
  dedup.
- **Candidates auto-linking to an already-promoted rule** (Phase 2) — the
  built-in "this rule may not be working" signal.

The promotion flow should present the choice explicitly: promote as a
context rule (soft, this module) or graduate to a guardrail policy (hard,
G4). Graduation itself stays human-curated for the same reason promotion
does.

### Efficacy is eval-gated

Phase 4's acceptance test proves *plumbing* (the rule appears in the next
run's assembled context), not *behavior change*. Because rules are soft,
whether injection actually corrects behavior is an empirical question — and
it is exactly what the [evaluations module](./prd-evaluations.md) measures:
run a regression set with and without the rule injected and compare. The
roadmap already sequences learned-rules after evaluations Phase 1; once both
exist, rule-efficacy evals should back the promotion/graduation judgment
(e.g. a rule that shows no behavioral delta is a graduation candidate or a
dismissal, not a keeper).

## Data Model

### CandidateRule

| Field                 | Type           | Description                                                    |
| --------------------- | -------------- | --------------------------------------------------------------- |
| `id`                  | string         | Public ID (`crl_` prefix)                                       |
| `project_id`          | string         | Owning project                                                  |
| `status`              | string         | `open` \| `promotion_suggested` \| `promoted` \| `dismissed`    |
| `source_kind`         | string         | `approval_rejected` \| `approval_edited` \| `manual`            |
| `source_ref`          | string \| null | Public ID of the source approval/exception                      |
| `text`                | string         | The correction, verbatim                                        |
| `embedding`           | vector         | For clustering (nullable, best-effort)                          |
| `occurrences`         | integer        | Cluster size after recurrence detection                         |
| `agent_id` / `run_id` | string \| null | Provenance                                                      |
| `promoted_rule_id`    | string \| null | Set on promotion or auto-link                                   |
| `dismissed_reason`    | string \| null | Required on dismissal                                           |
| `created_at` / `updated_at` | string   |                                                                 |

### LearnedRule

| Field           | Type           | Description                                         |
| --------------- | -------------- | ---------------------------------------------------- |
| `id`            | string         | Public ID (`lrl_` prefix)                            |
| `scope`         | string         | `global` \| `project`                                |
| `project_id`    | string \| null | Required when scope is `project`                     |
| `version`       | integer        | Incremented per update; prior versions archived to `LearnedRuleVersion` |
| `text`          | string         | The rule as injected                                 |
| `embedding`     | vector         | Embedding of `text`, refreshed on every version write (for candidate auto-linking) |
| `status`        | string         | `active` \| `inactive` \| `archived` — non-active rules stay for audit, stop injecting |
| `promoted_from` | string \| null | Source candidate                                     |
| `promoted_by`   | string         | Curating user                                        |
| `created_at` / `updated_at` | string |                                                     |

### LearnedRuleVersion

Archival table mirroring the guardrails `GuardrailVersion` pattern: every write
to a `LearnedRule` (any `PUT` that changes `text`, `scope`, or `status`, and
the archive operation) increments `version` on the live row and first copies
the **prior** document into `LearnedRuleVersion`. The current version always
lives on the `LearnedRule` row; history is append-only and never mutated.

| Column          | Type      | Constraints                                          |
| --------------- | --------- | ----------------------------------------------------- |
| `publicId`      | VARCHAR   | Public ID (`lrlv_` prefix, registered in `publicId.ts`) |
| `learnedRuleId` | FK        | → LearnedRule, NOT NULL                               |
| `version`       | INTEGER   | Unique with `learnedRuleId`                           |
| `text`          | TEXT      | Rule text as of this version                          |
| `scope`         | VARCHAR   | Scope snapshot as of this version                     |
| `projectId`     | FK \| NULL | Project snapshot as of this version                  |
| `status`        | VARCHAR   | Status snapshot as of this version                    |
| `updatedBy`     | FK        | User who superseded this version                      |
| `createdAt`     | TIMESTAMP | Immutable                                             |

Exposed read-only via `GET /api/v1/learned-rules/{rule_id}/versions` (fields
snake_case per the REST contract); versions are never written directly
through the API.

## Permissions

| Permission                          | Endpoint                                          |
| ----------------------------------- | -------------------------------------------------- |
| `learned-rules:CreateCandidateRule` | `POST /api/v1/candidate-rules`                     |
| `learned-rules:ListCandidateRules`  | `GET /api/v1/candidate-rules`                      |
| `learned-rules:GetCandidateRule`    | `GET /api/v1/candidate-rules/{candidate_id}`       |
| `learned-rules:PromoteCandidateRule`| `POST /api/v1/candidate-rules/{candidate_id}/promote` |
| `learned-rules:DismissCandidateRule`| `POST /api/v1/candidate-rules/{candidate_id}/dismiss` |
| `learned-rules:ListLearnedRules`    | `GET /api/v1/learned-rules`                        |
| `learned-rules:GetLearnedRule`      | `GET /api/v1/learned-rules/{rule_id}` (and `/versions`) |
| `learned-rules:UpdateLearnedRule`   | `PUT /api/v1/learned-rules/{rule_id}`              |
| `learned-rules:ArchiveLearnedRule`  | `DELETE /api/v1/learned-rules/{rule_id}`           |

Promotion to `global` scope requires admin.

## REST API

| Method | Path                                        | Description                                  |
| ------ | -------------------------------------------- | -------------------------------------------- |
| POST   | `/api/v1/candidate-rules`                    | Explicit correction capture                   |
| GET    | `/api/v1/candidate-rules`                    | List/filter (`status`, `project_id`); paginated |
| GET    | `/api/v1/candidate-rules/{candidate_id}`     | Get one candidate with provenance             |
| POST   | `/api/v1/candidate-rules/{candidate_id}/promote` | Promote with final text + scope           |
| POST   | `/api/v1/candidate-rules/{candidate_id}/dismiss` | Dismiss with reason                       |
| GET    | `/api/v1/learned-rules`                      | List rules (scope/project/`status` filters); paginated |
| GET    | `/api/v1/learned-rules/{rule_id}`            | Get one rule (current version)                |
| GET    | `/api/v1/learned-rules/{rule_id}/versions`   | List archived versions; paginated             |
| PUT    | `/api/v1/learned-rules/{rule_id}`            | New version / activate / deactivate           |
| DELETE | `/api/v1/learned-rules/{rule_id}`            | Archive (soft delete — see below)             |

Both list endpoints (and `/versions`) paginate with `limit` (default 20,
max 100) and `offset` query parameters, consistent with the rest of the API.

**Delete is archive, not hard delete (decision):** `DELETE` sets
`status: archived` rather than removing the row. Rationale: rules are audit
artifacts — candidates reference them via `promoted_rule_id` and past runs'
assembled contexts cite them, so hard deletion would break the provenance
chain the module exists to preserve. Archived rules stop injecting
immediately and are excluded from lists unless `status=archived` is passed.
