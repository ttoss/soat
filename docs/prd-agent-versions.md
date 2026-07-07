# PRD: Agent Versioning & Staged Rollout

> Part of [Agent Operations on Formations](./prd-agent-operations.md).
> Mirrors the version-archival pattern of `PolicyVersion`
> ([prd-guardrails.md](./prd-guardrails.md)) and `LearnedRuleVersion`
> ([prd-learned-rules.md](./prd-learned-rules.md)). Eval-gated promotion
> integrates with [prd-evaluations.md](./prd-evaluations.md).

## Implementation Status

| Component                                          | Status         | Notes                                                        |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `AgentVersion` model + snapshot-on-write hook      | ❌ Not started | One shared write path for REST and formation applies         |
| `version` column on Agent, returned in responses   | ❌ Not started | Starts at 1 on create                                        |
| List / get / restore version endpoints             | ❌ Not started | Restore is append-only (creates a new version)               |
| `active_release` (stable/canary split)             | ❌ Not started | Deterministic per-actor assignment                           |
| Served-version stamping on generations             | ❌ Not started | `agent_version` in generation metadata                       |
| Promote / abort release endpoints                  | ❌ Not started |                                                              |
| Eval-gated promotion (`promotion_gate`)            | ❌ Not started | Requires [prd-evaluations.md](./prd-evaluations.md) Phase 1+ |

## Problem

Guardrail policies and learned rules are getting append-only version history
(`PolicyVersion`, `LearnedRuleVersion`), but the **agent itself** — the
resource whose behavior those layers govern — has none. `instructions`,
`model`, `tools`, `knowledge_config`, and `boundary_policy` are mutable in
place: a bad instruction edit hits 100% of traffic the instant `PUT` returns,
and the only rollback is retyping the old prompt from memory or a git blame of
someone's local notes. Formations apply agent changes as IaC but keep no
resource-level history either — `plan` shows the diff before apply, then the
prior state is gone. There is no way to answer "what exactly was this agent
configured as when it produced generation X", no diff between two states, and
no way to try a change on 10% of traffic before committing to it.

## Goals

- Every mutation of an agent's config produces an immutable, retrievable
  snapshot — regardless of whether the edit came through REST or a formation
  apply.
- One-call rollback to any prior version, without rewriting history.
- Staged rollout: serve a candidate version to a deterministic fraction of
  traffic, observe, then promote or abort.
- Close the loop with evaluations: promotion can be gated on a passing eval
  run against the canary version — the headline integration with
  [prd-evaluations.md](./prd-evaluations.md).

## Non-goals

- No prompt-template library separate from agents.
- No multi-canary — exactly one canary version at a time.
- No UI (API-first; the app consumes it later).
- No automatic rollback on metric regression. Future sketch only: auto-abort
  when canary error rate exceeds stable's by a configurable margin over a
  rolling window — deliberately out of scope until usage metering exposes the
  needed aggregates.

## Key Concepts

### Config Snapshot

The `config` JSONB captures the full mutable surface from the agents OpenAPI
spec: `ai_provider_id`, `name`, `instructions`, `model`, `tool_ids`, `tools`
(inline definitions), `max_steps`, `tool_choice`, `stop_conditions`,
`active_tool_ids`, `step_rules`, `boundary_policy`, `temperature`,
`knowledge_config`, `output_schema`, `max_context_messages`,
`single_session_per_actor`.

**Not part of the snapshot:** runtime-injected context. Learned-rules
injection and knowledge retrieval pin at **generation time**, not snapshot
time — a version records *which* `knowledge_config` and rule scopes applied,
not the documents or rules themselves, which keep their own histories.

### Single Write Path (decision)

Snapshots are written inside the lib-layer update function
(`packages/server/src/lib/agents.ts`), the shared choke point that both the
REST `PUT`/`PATCH` handlers and `agentsFormationModule` already call.
Rationale: per the shared-business-rules convention, putting the hook at the
transport layer would require duplicating it per surface and would silently
miss any future caller; at the lib layer, a formation apply and an API edit
are indistinguishable and both leave history. No-op updates (deep-equal
config) do not create a version.

### Restore Is a New Version (decision)

`restore` copies version N's `config` into a **new** version M+1 rather than
rewinding the pointer. Rationale: history stays append-only (the same
invariant `PolicyVersion` and `LearnedRuleVersion` hold), audit references to
intermediate versions never dangle, and "undo the undo" works — restoring the
pre-restore version is just another restore.

### Deterministic Canary Split (decision)

With an `active_release`, each generation request is assigned
`stable_version` or `canary_version` by hashing the request's `actor_id`
(falling back to `session_id`, then random for anonymous one-shots) modulo
100 against `canary_percent`. Rationale: a stable hash means one actor never
flip-flops between prompts mid-conversation — a mid-session persona change is
worse than either version — and the split is reproducible in tests. The
served version is stamped on the generation record so traces and evals can
compare versions post hoc.

## Data Model

### AgentVersion

New table. Public ID prefix **`agver_`** — registered in
`packages/postgresdb/src/utils/publicId.ts`; no collision with existing
prefixes (`agent_`, `aip_`, …).

| Column        | Type       | Constraints                                             |
| ------------- | ---------- | ------------------------------------------------------- |
| `publicId`    | VARCHAR    | `agver_` prefix                                          |
| `agentId`     | FK         | → Agent, NOT NULL                                        |
| `version`     | INTEGER    | Unique with `agentId` (composite unique index)           |
| `config`      | JSONB      | Full config snapshot (fields above), NOT NULL            |
| `label`       | VARCHAR    | Optional human tag (e.g. `pre-tone-change`)              |
| `evalRunId`   | FK \| NULL | Eval run that validated this version ([prd-evaluations.md](./prd-evaluations.md)) |
| `createdBy`   | FK         | User or API key that caused the write                    |
| `createdAt`   | TIMESTAMP  | Immutable                                                |

Indexes: `(agentId, version)` unique; `(agentId, createdAt)` for paginated
listing.

### Agent (existing table) gains

| Field            | Type            | Description                                                       |
| ---------------- | --------------- | ------------------------------------------------------------------ |
| `version`        | INTEGER         | Current version; starts at 1, returned in all agent responses      |
| `activeRelease`  | JSONB \| NULL   | `{ stable_version, canary_version, canary_percent, promotion_gate? }` |

`promotion_gate` is an optional eval public ID (Phase 3).

## REST API

All bodies snake_case; path params `{agent_id}` / `{version}` per the case
convention. List endpoints paginate with `limit` (default 20, max 100) and
`offset`.

| Method | Path                                                   | Description                                                |
| ------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| GET    | `/api/v1/agents/{agent_id}/versions`                   | List versions, newest first; paginated                      |
| GET    | `/api/v1/agents/{agent_id}/versions/{version}`         | Get one version with full `config`                          |
| POST   | `/api/v1/agents/{agent_id}/versions/{version}/restore` | Create a new version copying this one's config              |
| PUT    | `/api/v1/agents/{agent_id}/release`                    | Set/replace `active_release` (Phase 2)                      |
| POST   | `/api/v1/agents/{agent_id}/release/promote`            | Canary becomes stable; release cleared. `409` if gate unmet |
| POST   | `/api/v1/agents/{agent_id}/release/abort`              | Clear release; all traffic back to stable                   |

Versions are never written directly — only via agent updates, formation
applies, and `restore`.

## Permissions

Added to the existing `packages/server/src/permissions/agents.json`:

| Permission                    | Endpoint                                                    |
| ----------------------------- | ------------------------------------------------------------ |
| `agents:ListAgentVersions`    | `GET /api/v1/agents/{agent_id}/versions`                     |
| `agents:GetAgentVersion`      | `GET /api/v1/agents/{agent_id}/versions/{version}`           |
| `agents:RestoreAgentVersion`  | `POST /api/v1/agents/{agent_id}/versions/{version}/restore`  |
| `agents:SetAgentRelease`      | `PUT .../release`, `POST .../release/promote` and `/abort`   |

## Implementation Phases

### Phase 1 — Version Snapshots + List/Get/Restore ❌ Not started

**Goal:** Every agent config mutation is recoverable.

**Deliverables:** `AgentVersion` model + `agver_` prefix; snapshot hook in
`lib/agents.ts`; `version` on Agent and in responses; the three version
endpoints; OpenAPI + SDK/CLI regeneration; formation module parity.

**Acceptance criteria:**

- Creating an agent yields `version: 1` and one `AgentVersion` row.
- `PUT` changing `instructions`, then `POST .../versions/1/restore`, yields
  `version: 3` whose `config` deep-equals version 1's; version 2 remains
  retrievable.
- A formation apply that changes the agent creates a version identical in
  shape to a REST-created one (`createdBy` set from the applying principal).
- A `PUT` with a deep-equal config creates no new version.
- `401`/`403`/`404` covered for all three endpoints; cross-project access
  returns `404`.

### Phase 2 — Releases + Deterministic Canary ❌ Not started

**Goal:** Try a version on a slice of traffic without touching the rest.

**Deliverables:** `active_release` JSONB + `PUT /release`, `promote`, `abort`;
hash-based assignment in the generation path; `agent_version` stamped in
generation metadata (visible in traces).

**Acceptance criteria:**

- With `canary_percent: 20` and 100 distinct `actor_id`s issuing generations,
  the served-version split is deterministic per actor (same actor → same
  version on repeat calls) and the canary share is within 20 ± 10.
- Every generation response/record includes the `agent_version` that served it.
- `promote` sets stable to the canary version and clears the release; `abort`
  clears it with stable unchanged.
- Setting a release referencing a nonexistent version returns `400`.

### Phase 3 — Eval-Gated Promotion ❌ Not started

**Goal:** "Promotion requires a green eval" as an enforced invariant, not a
convention.

**Deliverables:** `promotion_gate` on the release; `promote` checks for a
`passed` eval run of that eval against the canary version (matching on the
stamped `agent_version`) and returns `409` otherwise; `evalRunId` recorded on
the promoted version.

**Acceptance criteria:**

- With a gate set and no passing run, `promote` returns `409` with a
  `DomainError` code naming the gate; after a `passed` run against the canary
  version, the same call succeeds and the new stable version's `eval_run_id`
  links the run.
- A passing run against a *different* version does not satisfy the gate.

## Risks

- **Snapshot bloat.** Agents with fat `tools`/`output_schema` payloads and
  chatty formation pipelines could accumulate large JSONB history. Mitigated
  by the no-op-update guard; if needed later, add retention pruning — never
  for versions referenced by releases or `eval_run_id`.
- **Bypassed choke point.** A future write path that updates the Agent model
  directly would skip snapshotting. Mitigated by keeping the hook in the
  single lib update function and a test asserting no other module writes the
  Agent config columns.
- **Anonymous traffic skew.** Requests without `actor_id`/`session_id` are
  randomly assigned, so heavily anonymous workloads weaken the determinism
  guarantee — documented, and the stamp on each generation keeps analysis
  honest regardless.
- **Evaluations dependency.** Phase 3 depends on
  [prd-evaluations.md](./prd-evaluations.md) (in flight); Phases 1–2 are
  independent and ship first.
