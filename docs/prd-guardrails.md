# PRD: Guardrail Policies (Action Classes)

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G4).
> Routes class-C actions into [prd-approvals.md](./prd-approvals.md); reads
> spend/usage context from [prd-usage-metering.md](./prd-usage-metering.md).

> **Placement decision (2026-07) — supersedes the "reuses the policies module
> surface" framing below.** Guardrails ship as a **standalone `guardrails`
> resource** (own `guard_` id, own `guardrails:*` permission namespace, own
> `GuardrailVersion` / `ProjectGuardrailOverride`, agent opt-in via
> `guardrail_id`) — **not** as a `kind` discriminator on the IAM `policies`
> resource. Rationale: guardrails evaluate at the agent tool-dispatch boundary
> (by arguments/context) rather than at request auth (by principal), attach
> differently, and keeping them separate leaves the security-critical IAM module
> untouched. The authoritative user-facing contract is
> [guardrails.md](../packages/website/docs/modules/guardrails.md); read the
> resource/permission/endpoint sections below through that lens (Policy →
> Guardrail, `pol_` → `guard_`, `policies:*` → `guardrails:*`,
> `ProjectPolicyOverride` → `ProjectGuardrailOverride`).

> **Context decision (2026-07) — supersedes the fixed provider-catalog framing
> below (§ named context providers).** Guard context is **application-owned**.
> Guards resolve `var`s against three namespaces: `args.*` (call arguments),
> `context.*` (the effective guardrail context), and `soat.*` (the reserved
> platform-computed catalog: identity, run state, usage, activity). The caller
> passes a free-form `guardrail_context` object on the generation /
> orchestration-run request; a guardrail may additionally name a
> `context_tool_id` the platform calls at evaluation time — fresh context for
> long-lived runs — combined with the caller object per `context_mode` (`merge`
> default, tool wins on conflict; or `replace`). Fail-closed: a missing
> `context.*` key, context-tool failure/timeout, or unresolvable `soat.*`
> provider counts as a failed guard. The authoritative contract is
> [guardrails.md — Guards and Guardrail Context](../packages/website/docs/modules/guardrails.md).
> This also changes the audit record: the effective `context.*` object is
> frozen as `context_snapshot` (values), with keys-only retained for `soat.*`.

## Implementation Status

| Component                                     | Status         | Notes                                                              |
| --------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `kind` discriminator on the policy resource   | ❌ Not started | `permissions` (existing, default) \| `action_classes`               |
| Action-class policy document schema + validation | ❌ Not started | Versioned; rules of `{ match, class, guards, escalate }`           |
| Tool-boundary interceptor (classify → route)  | ❌ Not started | Agent loop + orchestration tool nodes; fail-closed default class C |
| Guard expression evaluation (JSON Logic)      | ❌ Not started | Reuses the evaluator orchestrations already use; no LLM in the path |
| Named context providers                       | ❌ Not started | Fixed key catalog: `project.context.*`, `run.*`, `activity.*`, `usage.*` |
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
- Named context providers resolved before evaluation, drawn from a **fixed
  key catalog** (see [Context Provider Catalog](#context-provider-catalog)):
  `args.*`, `project.context.*`, `run.*`, `activity.*`, and `usage.*`.
  Referencing a key outside the catalog fails closed at policy-validation
  time (`400` on write)
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
  generation/run record, following the schema in
  [Evaluation Audit Record](#evaluation-audit-record)
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

### Context Provider Catalog

Guard expressions may reference only keys from this catalog. Windows are not
free parameters: they are part of the key name, from a fixed suffix set
(`_1h`, `_24h`, `_7d`, `_30d`), and every window is **rolling, ending at
evaluation time**. **Decision:** a fixed catalog of keys rather than
parameterized windows (`usage.cost_usd(window: …)`) — keys stay statically
validatable and grep-able, and adding a window or aggregate is a reviewed
code change, not an expression-language extension.

| Key                                                        | Type       | Window semantics                        | Source                                        |
| ---------------------------------------------------------- | ---------- | ---------------------------------------- | ---------------------------------------------- |
| `args.*`                                                   | any JSON   | — (the proposed call)                    | Tool arguments produced by the LLM             |
| `project.context.*`                                        | as configured | — (current value)                     | Project-level configuration values             |
| `run.node_attempt`                                         | integer    | Current run                              | Orchestration run state (attempt counter)      |
| `run.tool_calls`                                           | integer    | Current run                              | Tool calls executed so far in this run         |
| `activity.actions_1h` / `activity.actions_24h`             | integer    | Rolling 1h / 24h                         | [Activity feed](./prd-approvals.md)            |
| `usage.cost_usd_1h` / `_24h` / `_7d` / `_30d`              | number     | Rolling 1h / 24h / 7d / 30d              | [Usage metering](./prd-usage-metering.md)      |
| `usage.tokens_24h` / `usage.tokens_30d`                    | integer    | Rolling 24h / 30d                        | [Usage metering](./prd-usage-metering.md)      |

`activity.*` and `usage.*` aggregates are scoped to the evaluating project.

**Fail-closed at both ends:** a policy document referencing any `var` outside
`args.*`, `project.context.*`, or the catalog above is rejected with `400` at
policy-validation (write) time — never silently `null` at runtime. If a
cataloged provider fails to resolve at evaluation time (e.g. metering
unavailable), the guard counts as **failed** and tripwire semantics apply.

### Policy Versioning

Every write to an `action_classes` policy increments `version` and archives
the prior document. Approval items, activity entries, and exceptions record
the version that governed them, so the audit chain survives policy edits.

### Evaluation Audit Record

Every evaluation writes an `ActivityEntry` whose `detail` follows this
snake_case schema (also stored on the generation/run record):

```json
{
  "kind": "guardrail_evaluation",
  "policy_id": "pol_V1StGXR8Z5jdHi6B",
  "policy_version": 3,
  "override_version": 1,
  "tool": "update-budget",
  "rule_index": 0,
  "class": "B",
  "decision": "execute",
  "guard_results": [
    { "index": 0, "result": true },
    { "index": 1, "result": true }
  ],
  "context_snapshot_keys": [
    "args.amount",
    "project.context.max_daily_budget",
    "usage.cost_usd_24h"
  ],
  "agent_id": "agent_V1StGXR8Z5jdHi6B",
  "run_id": "orch_run_V1StGXR8Z5jdHi6B",
  "generation_id": "gen_V1StGXR8Z5jdHi6B"
}
```

- `decision` ∈ `execute` \| `route_to_approval` \| `blocked` \| `tripwire`
- `rule_index` is the index of the first matching rule in the governing
  document; `-1` means no rule matched and `default_class` applied
- `override_version` is `null` when no project override was layered in
- **Decision:** the record stores context snapshot **keys only**, not values —
  provider values can embed sensitive tool arguments, and the args already
  live on the approval item / generation record. Guard outcomes are captured
  per guard in `guard_results`, so the evaluation is reconstructable against
  the archived policy version

**One-query audit:** "which policy version allowed this call" is answerable
directly from the detail:

```sql
SELECT detail->>'policy_id'              AS policy_id,
       (detail->>'policy_version')::int  AS policy_version,
       detail->>'decision'               AS decision
FROM activity_entries
WHERE detail->>'kind' = 'guardrail_evaluation'
  AND detail->>'generation_id' = 'gen_V1StGXR8Z5jdHi6B';
```

The exact governing document is then
`GET /api/v1/policies/{policy_id}/versions/{policy_version}`.

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
| `policies:SetProjectPolicyOverride` | `PUT /api/v1/projects/{project_id}/policy-overrides/{policy_id}` |
| `policies:GetPolicyVersion`       | `GET /api/v1/policies/{policy_id}/versions/{version}`     |

## REST API

| Method | Path                                                        | Description                              |
| ------ | ----------------------------------------------------------- | ---------------------------------------- |
| POST/PUT | `/api/v1/policies` (existing)                              | `kind: action_classes` selects the new schema |
| GET    | `/api/v1/policies/{policy_id}/versions/{version}`            | Fetch an archived document version        |
| PUT    | `/api/v1/projects/{project_id}/policy-overrides/{policy_id}` | Set/replace the project override          |
| DELETE | `/api/v1/projects/{project_id}/policy-overrides/{policy_id}` | Remove the override                       |
