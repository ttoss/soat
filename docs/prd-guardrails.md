# PRD: Guardrail Policies (Action Classes)

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G4).
> Routes class-C actions into [prd-approvals.md](./prd-approvals.md); reads
> spend/usage context from [prd-usage-metering.md](./prd-usage-metering.md).

## Implementation Status

| Component                                     | Status         | Notes                                                              |
| --------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `kind` discriminator on the policy resource   | ❌ Not started | `permissions` (existing, default) \| `action_classes`               |
| Action-class policy document schema + validation | ❌ Not started | Versioned; rules of `{ match, class, guards, escalate }`           |
| Tool-boundary interceptor (classify → route)  | ❌ Not started | Agent loop + orchestration tool nodes; fail-closed default class C |
| Guard expression evaluation (JSON Logic)      | ❌ Not started | Reuses the evaluator orchestrations already use; no LLM in the path |
| Named context providers                       | ❌ Not started | `project.context.*`, `activity.*`, `usage.*`                        |
| Tripwire semantics (abort + exception)        | ❌ Not started | `escalate: true` downgrades to approval instead                     |
| Per-project overrides                         | ❌ Not started | Layer over the template policy; can only tighten                    |
| Evaluation audit log                          | ❌ Not started | Every pass/block logged with the policy version                     |

## Implementation Phases

### Phase 1 — Policy Kind + Classifier + Routing ❌ Not started

**Goal:** Every tool call from a guarded agent is classified deterministically
and routed: execute, queue for approval, or never attach — with unmatched
actions failing closed.

**Deliverables:**

- `kind` column on the policy resource (`permissions` default keeps every
  existing policy valid; `kind: action_classes` selects the new document
  schema). Formation `policy` resource type passes `kind` through
- Document schema (validated on write, versioned on every update):

```yaml
version: 3
default_class: C # unmatched actions fail closed
rules:
  - match: { tool: update-budget, where: { '<': [{ var: 'args.amount' }, 500] } }
    class: B
    guards:
      - { '<=': [{ var: 'args.amount' }, { var: 'project.context.max_daily_budget' }] }
      - { '<': [{ var: 'usage.cost_usd_24h' }, { var: 'project.context.cost_ceiling' }] }
  - match: { tool: update-budget }
    class: C
  - match: { tool: delete-account }
    class: D
```

- Classes: **A** (read-only — always execute), **B** (autonomous iff **all**
  guards pass), **C** (always routes to an
  [`ApprovalItem`](./prd-approvals.md)), **D** (never available — enforced by
  not attaching the tool, which the existing caller ∩ agent permission
  intersection already supports; the classifier double-checks as
  defense-in-depth)
- `guardrail_policy_id` on the Agent (and per-generate override, project-gated)
- Interceptor at the tool-execution boundary — the last hop before actuation,
  shared by the agent loop and orchestration tool nodes, so LLM output cannot
  bypass it

**Unlocks:** Autonomous execution of safe actions with hard, non-LLM limits on
everything else.

### Phase 2 — Guards + Context Providers ❌ Not started

**Goal:** Class-B autonomy bounded by deterministic, data-driven expressions.

**Deliverables:**

- Guard expressions in **JSON Logic** — the same evaluator orchestration
  `input_mapping`/`condition` nodes already use; one expression language
  across the platform, no `eval`, no I/O
- Named context providers resolved before evaluation:
  - `args.*` — the proposed tool arguments
  - `project.context.*` — project-level configuration values (per-project
    limits such as budget ceilings)
  - `activity.*` — recent-activity aggregates (e.g.
    `activity.actions_24h`), computed from the
    [activity feed](./prd-approvals.md)
  - `usage.*` — cost/token aggregates in a window, from
    [prd-usage-metering.md](./prd-usage-metering.md)
- **Tripwire semantics:** a failing guard **aborts the run** and files an
  `ExceptionItem` — it does not silently downgrade. A rule with
  `escalate: true` opts into downgrade-to-approval instead
- New providers are code, reviewed like code — the expression language itself
  stays capped at JSON Logic operators

**Unlocks:** Guards like "budget delta under X% per 24h" and "cost ceiling per
window" enforced identically on every action, with runaway loops tripping
fail-closed.

### Phase 3 — Overrides + Audit ❌ Not started

**Goal:** Per-project risk posture and a complete evaluation record.

**Deliverables:**

- Per-project override document layered over the template policy at
  evaluation time. Overrides can **tighten only**: downgrade B → C, add
  guards, lower `default_class` — never upgrade C → B or remove guards
- Every evaluation (pass, route-to-approval, or block) logged with the policy
  **version**, matched rule index, guard results, and provenance
  (run/node/agent) — recorded as an `ActivityEntry` detail and on the
  generation/run record
- Post-action hooks on rules (e.g. `notify: [webhook]`) so a high-impact
  class-B action (a kill switch) can execute immediately *and* alert

**Unlocks:** The audit requirement — "which policy version allowed this
action" answerable with one query — and customer-controlled autonomy levels.

## Overview

The existing [policies module](../packages/website/docs/modules/policies.md)
answers *"may this caller invoke this endpoint?"*. It cannot express *"an
agent may change a budget autonomously only below this amount, and must ask a
human otherwise"* — a rule about the **arguments and context** of a specific
tool call at execution time.

Guardrail policies add that layer as **data, not code**: a versioned document
mapping tool calls to action classes with deterministic guard expressions.
Enforcement lives at the tool-execution boundary, after the LLM has produced
the call and before anything touches the outside world. There is deliberately
no LLM anywhere in the evaluation path.

## Key Concepts

### Action Classes

| Class | Meaning                | Behavior                                                       |
| ----- | ---------------------- | --------------------------------------------------------------- |
| A     | Read-only / harmless   | Execute; log to activity feed                                   |
| B     | Autonomous with guards | Execute iff **all** guards pass; guard failure = tripwire       |
| C     | Human sign-off         | Create an `ApprovalItem`, park the run; execute only on approval |
| D     | Forbidden              | Tool never attached; classifier blocks as defense-in-depth      |

Unmatched actions take `default_class`, which itself defaults to **C**:
anything nobody classified requires a human. Fail-closed is the invariant the
test suite proves.

### Match Predicates

`match.tool` names a tool (by ID or name); `match.where` is an optional JSON
Logic predicate over the arguments, so the same tool can be class B below a
threshold and class C above it. First matching rule wins; rules are ordered.

### Policy Versioning

Every write to an `action_classes` policy increments `version` and archives
the prior document. Approval items, activity entries, and exceptions record
the version that governed them, so the audit chain survives policy edits.

## Data Model

Policy resource (existing table) gains:

| Field      | Type    | Description                                            |
| ---------- | ------- | ------------------------------------------------------- |
| `kind`     | string  | `permissions` (default) \| `action_classes`             |
| `version`  | integer | Incremented per document write (for `action_classes`)   |

New `PolicyVersion` table (`policyId`, `version`, `document`, `createdAt`)
archives prior documents for audit.

Per-project overrides: `ProjectPolicyOverride`
(`projectId`, `policyId`, `document`, `version`, timestamps).

## Permissions

Reuses the policies module surface (`policies:CreatePolicy`, …). New:

| Permission                        | Endpoint                                                |
| --------------------------------- | -------------------------------------------------------- |
| `policies:SetProjectPolicyOverride` | `PUT /api/v1/projects/:projectId/policy-overrides/:policyId` |
| `policies:GetPolicyVersion`       | `GET /api/v1/policies/:policyId/versions/:version`        |

## REST API

| Method | Path                                                        | Description                              |
| ------ | ----------------------------------------------------------- | ---------------------------------------- |
| POST/PUT | `/api/v1/policies` (existing)                              | `kind: action_classes` selects the new schema |
| GET    | `/api/v1/policies/:policyId/versions/:version`               | Fetch an archived document version        |
| PUT    | `/api/v1/projects/:projectId/policy-overrides/:policyId`     | Set/replace the project override          |
| DELETE | `/api/v1/projects/:projectId/policy-overrides/:policyId`     | Remove the override                       |
