# PRD: Learned Rules (Feedback Loop)

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G6).
> Captures from [prd-approvals.md](./prd-approvals.md) resolution paths;
> injects through the context assembler in
> [prd-knowledge-packages.md](./prd-knowledge-packages.md). Reuses the
> embedding nearest-neighbor machinery from
> [prd-memories.md](./prd-memories.md).

## Implementation Status

| Component                                | Status         | Notes                                                            |
| ---------------------------------------- | -------------- | ------------------------------------------------------------------|
| `CandidateRule` model + capture hooks    | ❌ Not started | Auto-created from rejections, edits, and explicit corrections      |
| Recurrence detection (clustering)        | ❌ Not started | Embedding NN pass; repeated corrections flag `promotion_suggested` |
| Promotion lifecycle + `LearnedRule`      | ❌ Not started | Human-curated; `candidate → promoted \| dismissed`                 |
| Scoped injection into context assembly   | ❌ Not started | `global \| project`; most specific last                            |
| REST endpoints + OpenAPI + permissions   | ❌ Not started | Curation UI/flow is a consumer, not part of this module            |

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
  history
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
| `version`       | integer        | Incremented per update; history preserved            |
| `text`          | string         | The rule as injected                                 |
| `active`        | boolean        | Inactive rules stay for audit, stop injecting        |
| `promoted_from` | string \| null | Source candidate                                     |
| `promoted_by`   | string         | Curating user                                        |
| `created_at` / `updated_at` | string |                                                     |

## Permissions

| Permission                          | Endpoint                                          |
| ----------------------------------- | -------------------------------------------------- |
| `learned-rules:CreateCandidateRule` | `POST /api/v1/candidate-rules`                     |
| `learned-rules:ListCandidateRules`  | `GET /api/v1/candidate-rules`                      |
| `learned-rules:PromoteCandidateRule`| `POST /api/v1/candidate-rules/:id/promote`         |
| `learned-rules:DismissCandidateRule`| `POST /api/v1/candidate-rules/:id/dismiss`         |
| `learned-rules:ListLearnedRules`    | `GET /api/v1/learned-rules`                        |
| `learned-rules:UpdateLearnedRule`   | `PUT /api/v1/learned-rules/:ruleId`                |

Promotion to `global` scope requires admin.

## REST API

| Method | Path                                        | Description                                  |
| ------ | -------------------------------------------- | -------------------------------------------- |
| POST   | `/api/v1/candidate-rules`                    | Explicit correction capture                   |
| GET    | `/api/v1/candidate-rules`                    | List/filter (`status`, `project_id`)          |
| POST   | `/api/v1/candidate-rules/:id/promote`        | Promote with final text + scope               |
| POST   | `/api/v1/candidate-rules/:id/dismiss`        | Dismiss with reason                           |
| GET    | `/api/v1/learned-rules`                      | List rules (scope/project filters)            |
| PUT    | `/api/v1/learned-rules/:ruleId`              | New version / activate / deactivate           |
