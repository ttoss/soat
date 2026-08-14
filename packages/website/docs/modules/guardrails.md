---
description: "First-class action-class policies that classify each agent tool call — execute, require approval, or block — with non-LLM guard expressions and project / agent / tool attach scopes that compose stricter-wins."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Guardrails

Guardrails classify every tool call an agent makes into an action class — execute autonomously, route to human approval, or block — using deterministic, non-LLM guard expressions.

## Overview

A guardrail is a **standalone, versioned resource** — separate from [IAM policies](./policies.md). Where an IAM policy answers _"may this caller invoke this endpoint?"_ at request time, a guardrail answers _"may this agent take **this specific action, with these arguments, in this context**, on its own — or must a human sign off?"_. It maps tool calls to **action classes** (A/B/C/D) and gates class-B autonomy behind guard expressions evaluated at the tool-execution boundary — after the model produces the call and before anything touches the outside world. There is no LLM in the evaluation path.

Guardrails are the platform's **single tool-call gating mechanism**: class-C actions route into the [approvals queue](./approvals.md), guards read spend from [usage metering](./usage.md), and expressions use the shared [JSON Logic](https://jsonlogic.com) evaluator that [orchestrations](./orchestrations.md) use. A guardrail is a reusable template: tools, agents, and projects each carry a `guardrail_ids` list, so it [attaches](#attachment) at any of those three scopes, several can apply to one call, and the strictest decision wins — every added guardrail can only tighten the result, never loosen it.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Gate a Dangerous Tool with Guardrails - Step 4 (Write the guardrail)](/docs/tutorials/gate-a-tool-with-guardrails#step-4--write-the-guardrail)
- [Gate a Dangerous Tool with Guardrails - Step 5 (Dry-run every decision)](/docs/tutorials/gate-a-tool-with-guardrails#step-5--dry-run-every-decision-before-attaching)
- [Gate a Dangerous Tool with Guardrails - Step 10 (A failing guard: the tripwire)](/docs/tutorials/gate-a-tool-with-guardrails#step-10--a-failing-guard-the-tripwire)
- [Gate a Dangerous Tool with Guardrails - Step 12 (Raise the floor for the whole project)](/docs/tutorials/gate-a-tool-with-guardrails#step-12--raise-the-floor-for-the-whole-project)

## Data Model

### Guardrail

| Field         | Type    | Description                                                        |
| ------------- | ------- | ------------------------------------------------------------------ |
| `id`          | string  | Public identifier prefixed with `guard_`                           |
| `project_id`  | string  | ID of the owning project                                           |
| `name`        | string  | Human-readable name                                                |
| `description` | string  | Optional description                                               |
| `version`     | integer | Incremented on every `document` write; prior versions are archived |
| `document`    | object  | The action-class document (see below)                              |
| `context_tool_id` | string | Optional [tool](./tools.md) the platform calls at evaluation time to fetch fresh [guardrail context](#guards-and-guardrail-context) |
| `context_mode` | string \| null | How tool-fetched context combines with the caller-supplied context: `merge` (default) or `replace`. `null` when explicitly cleared |
| `created_at`  | string  | ISO 8601 creation timestamp                                        |
| `updated_at`  | string  | ISO 8601 last-updated timestamp                                    |

The `document`:

| Field           | Type              | Description                                                                                  |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `class`         | string \| object  | A class literal (`"A"` \| `"B"` \| `"C"` \| `"D"`) **or** a JSON Logic expression returning one — see [Classification](#classification) |
| `default_class` | string            | Applied when the `class` expression returns anything other than a valid class (a missing key, `null`, a typo). Defaults to `C` (fail-closed) |
| `guard`         | object            | A single JSON Logic expression; when the call classifies as `B`, it must evaluate truthy to execute autonomously. Compose multiple conditions with `{ "and": [...] }` |
| `escalate`      | boolean           | When `true`, a failing guard routes to approval instead of tripping fail-closed              |

### GuardrailVersion

An immutable archive of a guardrail's configuration at one version. Shares its shape — and the engine that reads and writes it — with [`AgentVersion`](./agents.md#versioning-and-staged-rollout).

| Field          | Type    | Description                                                                 |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `id`           | string  | `guard_ver_`-prefixed public ID of the archived version                     |
| `guardrail_id` | string  | The `guard_`-prefixed guardrail this version belongs to                     |
| `version`      | integer | The archived version number                                                 |
| `config`       | object  | The versioned surface at that version — today `{ document }` and nothing else |
| `label`        | string  | Optional human tag, e.g. `pre-tightening`; null when unset                   |
| `created_by`   | string  | Public ID of the user whose action produced this version; null when there was none |
| `created_at`   | string  | ISO 8601 timestamp                                                          |

Only the policy `document` is versioned. Name, description and the context binding are metadata — versioning them would make two version numbers denote the same policy, and the version number is what an [evaluation record](#evaluation-audit-record) cites.

## Key Concepts

### Attachment

A guardrail attaches through a `guardrail_ids` array on one of three resources — not the way IAM policies attach to users and API keys. Every field is a list, so each scope can carry several composable guardrails:

- **On a project** — governs **every** tool call by **every** agent in the project: the baseline scope, a floor narrower scopes can only raise.
- **On an agent** — governs **every** tool call the agent makes, across all its bindings.
- **On a tool** — governs that tool **wherever it is used**, by any agent; binding a dangerous tool to a new agent can never silently escape classification.

**Attach is cheap, detach is gated.** Adding an id can only tighten the outcome, so it needs only the carrying resource's update permission (`tools:UpdateTool`, `agents:UpdateAgent`, `projects:UpdateProject`). Removing an id — at **any** scope — can loosen posture, so it additionally requires `guardrails:DetachGuardrail`. The floor can't be silently lowered from any scope.

Every guardrail that applies to a call **evaluates, and the strictest decision wins**, ordered `blocked` > `tripwire` > `route_to_approval` > `execute`; where several classify the same call as `B`, **all their guards must pass**. Composition is order-independent — `A` is the identity, so a guardrail returning `"A"` defers to the others. One `guardrail_evaluation` record is written per guardrail evaluated.

### Action Classes

| Class | Meaning                | Behavior                                                                                     |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------- |
| **A** | Read-only / harmless   | Always execute; logged to the activity feed                                                  |
| **B** | Autonomous with a guard | Execute **iff the guard passes**; a failing guard trips fail-closed (or routes to approval — see [Tripwires](#tripwires-and-escalate)) |
| **C** | Human sign-off         | Files an [`ApprovalItem`](./approvals.md) (`origin: tool_call`); executes only on approval    |
| **D** | Forbidden              | The call is blocked at dispatch; the model receives a blocked tool result and continues its turn |

A `class` expression that returns anything other than `"A"` / `"B"` / `"C"` / `"D"` resolves to `default_class`, which itself defaults to **C**: a misconfigured or absent classification never grants autonomy.

Class-C interception uses the return-pending mechanics the [approvals queue](./approvals.md) defines: the call returns `{ "status": "pending_approval", "approval_id": …, "expires_at": … }` as the tool result, the turn completes normally, and resolution starts a continuation generation that executes the frozen (or edited) arguments.

A guardrail may carry an optional **`expires_in`** (seconds) in its document — the sign-off window for a class-C approval it files (default 24h). When several guardrails apply, the governing (strictest-matching) guardrail's `expires_in` wins; it applies wherever a guardrail files an approval — agent tool-dispatch and the [orchestration tool node](#orchestration-tool-nodes) alike.

### Classification

`class` is either a literal (`{ "class": "C" }` always requires sign-off) or a **single JSON Logic expression** returning the class, evaluated over the same three namespaces as guards (`args.*` / `context.*` / `soat.*`). There is no rule list and no matching order: one expression, one result. Anything the expression doesn't account for falls through to `default_class`.

A guardrail reasons about **this** call, not about which tool it is: to gate several tools differently, create a guardrail per tool and [attach](#attachment) each to its tool rather than branching on `soat.tool.name`. This example classifies a budget-update call **B** below a threshold and **C** at or above it:

```json
{
  "default_class": "C",
  "class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
  "guard": { "<=": [{ "var": "args.amount" }, { "var": "context.max_daily_budget" }] }
}
```

### Guards and Guardrail Context

Both `class` and `guard` are **single JSON Logic expressions** — the same evaluator [orchestration](./orchestrations.md) mappings use — with no `eval` and no LLM in the path. JSON Logic composes on its own (`if`/`and`/`or`/`!`), so there are no rule or guard arrays. Every `var` resolves against exactly three namespaces:

| Namespace   | Source                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `args.*`    | The proposed call's arguments (post preset-merge — the same frozen arguments an [approval item](./approvals.md) records) |
| `context.*` | The **effective guardrail context** — application-owned, see below                                             |
| `soat.*`    | Platform-computed values (fixed catalog below); reserved — never writable by the caller or the context tool     |

**Guardrail context is application-owned.** The caller passes a free-form `guardrail_context` object on the generation request or orchestration-run start; the platform never interprets it. For long-lived work (an orchestration run can park at an approval node for days), a run-start snapshot goes stale, so a guardrail may also name a `context_tool_id` — an ordinary [tool](./tools.md) the platform calls at **evaluation time**, immediately before classifying each gated call. `context_mode` controls the combination: `merge` (default) shallow-merges top-level keys over the caller-supplied object, the tool's value winning on conflict; `replace` substitutes it entirely.

The context tool executes **under the calling agent's credentials** — same project scoping, same secret resolution — so a guardrail can never read data the agent could not reach. The platform's dispatch path invokes it; the model never sees it and its result never enters the model context. If the agent cannot access the tool, the standard fail-closed rule applies. The call is bounded by a per-call timeout and a short per-`(project, guardrail)` TTL cache.

The `soat.*` catalog (windows are baked into the key name — a fixed suffix set `_1h` / `_24h` / `_7d` / `_30d`, each rolling and ending at evaluation time):

| Key                                                        | Type    | Source                                                  |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `soat.action` / `soat.tool.id` / `soat.tool.name`          | string  | The call being classified                               |
| `soat.agent.id` / `soat.project.id`                        | string  | Evaluation identity                                     |
| `soat.run.node_attempt` / `soat.run.tool_calls`            | integer | Current [orchestration run](./orchestrations.md) state  |
| `soat.activity.actions_1h` / `soat.activity.actions_24h`   | integer | [Activity feed](./activity.md) (per project)            |
| `soat.usage.cost_usd_1h` / `_24h` / `_7d` / `_30d`         | number  | [Usage metering](./usage.md) (per project)              |
| `soat.usage.tokens_24h` / `soat.usage.tokens_30d`          | integer | [Usage metering](./usage.md) (per project)              |
| `soat.usage.run_tokens` / `soat.usage.run_cost_usd`        | number  | [Usage metering](./usage.md) (**per run**, cumulative)  |

`soat.activity.actions_1h` / `actions_24h` count this project's `action_executed` entries on the [activity feed](./activity.md#the-feed-as-a-guardrail-signal) over the rolling window, read live. An empty feed reads as a real `0`; only a failing query falls back to the fail-closed rule.

`soat.usage.run_tokens` / `run_cost_usd` are the odd pair out: they sum only the meter rows of the **current [orchestration run](./orchestrations.md)**, read live — see [Per-run spend ceilings](#per-run-spend-ceilings).

**Fail-closed at both ends.** At write time, a document referencing a `var` outside the three namespaces — or a `soat.*` key outside the catalog — is rejected with `400`. At evaluation time, a `context.*` key absent from the effective context, a context-tool failure or timeout, or an unresolvable `soat.*` provider all fail closed: in `class`, the result resolves to `default_class`; in `guard`, it counts as a **failed guard** and tripwire semantics apply. Forgetting to supply context tightens the posture, never loosens it.

**Variable casing.** `guardrail_context` (and a dry-run's `args`) is an application-owned bag — keys pass through **verbatim**, with no snake↔camel conversion. Author the document path and the context key in the same case; snake_case is recommended (it matches the `soat.*` catalog), so `{ "var": "context.max_daily_budget" }` reads a supplied `max_daily_budget`.

**Missing keys and comparisons.** JSON Logic coerces an absent `var` to a falsy, zero-ish value, so `{ "<": [{ "var": "args.amount" }, 500] }` is `true` when `args.amount` is absent. When a missing argument must **not** reach the permissive branch, test presence explicitly: `{ "and": [{ "var": "args.amount" }, { "<": [{ "var": "args.amount" }, 500] }] }`.

### Tripwires and `escalate`

A failing class-B guard is a **tripwire**: by default it aborts the action and files an exception — a runaway loop hits a hard, non-LLM stop. `escalate: true` opts into the softer behavior: a failing guard routes the call to the [approvals queue](./approvals.md) instead.

`escalate` is **per-guardrail**: a failing guard yields that guardrail's own decision — `tripwire` without `escalate`, `route_to_approval` with it — and the strictest decision across all applying guardrails still wins (`tripwire` outranks `route_to_approval` in the [decision ordering](#attachment)), so opting one guardrail into escalation never softens another's hard stop.

### Per-run spend ceilings

A runaway [orchestration run](./orchestrations.md) is not caught by a project-windowed budget guard: the window barely moves while one run burns through its budget. `soat.usage.run_tokens` and `soat.usage.run_cost_usd` expose the **current run's** cumulative metered spend, live at evaluation time, so a ceiling trips mid-run on the tool call that crosses it.

Give the ceiling itself as `guardrail_context` (or a context tool) so one guardrail serves every run:

```bash
soat create-guardrail \
  --name "Per-run token ceiling" \
  --document '{
    "class": "B",
    "guard": {
      "<": [
        { "var": "soat.usage.run_tokens" },
        { "var": "context.action_token_ceiling" }
      ]
    }
  }'
```

Attach it to the tools the run dispatches: once the run crosses the ceiling the guard fails and class-B tripwire semantics abort the call **before** the tool runs. Swap `run_tokens` for `run_cost_usd` to cap dollars.

Two properties worth knowing:

- **Fail-closed outside a run.** Both keys are unresolvable when no run is in scope (they do **not** read as `0`), so a per-run ceiling attached at project scope trips on plain agent calls too — attach at tool scope unless that is intended.
- **Metering granularity is the resolution.** The counters advance as each provider call is metered (see [usage coverage](./usage.md#coverage)), so a ceiling trips on the first gated call *after* it is crossed — a single over-budget call can still complete.

### Client Tools

Guardrails classify calls to [client tools](./tools.md) like any other, but because actuation happens on the client, the gate sits at the `requires_action` **handoff**: class **A** and a passing **B** hand the call to the client as usual; class **C** files the approval item first, and the handoff happens only on approval; class **D** blocks the handoff; a tripwire aborts before anything reaches the client. The guardrail governs whether the call is released to the client at all — the platform cannot observe what the client does after.

### Orchestration tool nodes

An [orchestration](./orchestrations.md) `tool` node is gated at dispatch just like an agent tool call, but with no agent in scope it composes only the **project + tool** scopes (`agentId`/`generationId` are `null` on the evaluation identity and audit record). The strictest decision is enacted in orchestration terms:

- **A / passing B** — the tool executes with the (cleaned) node inputs.
- **C** — the run **parks** on the node with a `requires_action` of `type: "approval"`, filing an [`ApprovalItem`](./approvals.md) (`origin: node`). On approval the node re-dispatches with the frozen (or edited) arguments — the guardrail is **not** re-evaluated; on rejection or expiry the tool never runs and only a matching decision edge (`condition: "rejected"` / `"expired"`) follows.
- **D / tripwire** — a **routable `blocked` outcome**, not a run failure: the node records a `{ status, reason }` artifact and branches by label, so an edge conditioned on `blocked` (or `tripwire`) routes to a fallback path. An unlabeled success edge does **not** auto-follow a blocked node.

### Running a tighter posture in one project

There is no separate override resource. A project runs a stricter posture by [attaching](#attachment) a tighter guardrail at its **project** scope — e.g. `{ "class": "C" }` forces sign-off on every call its agents make — or at one tool's scope to tighten just that tool. Stricter-wins guarantees the attachment can only tighten, and other projects are untouched.

### Versioning

A guardrail's policy is versioned by the same append-only archive that backs [agent versions](./agents.md#versioning-and-staged-rollout). Version 1 is written on create, and every write that **changes** the `document` increments `version` and archives it as a `GuardrailVersion`. Approval items, activity entries, and exceptions record the version that governed them.

Three writes archive nothing — a version exists to name a distinct policy: a metadata-only edit (`name`, `description`, `context_tool_id`, `context_mode`); re-writing the document the guardrail already holds (compared structurally); restoring the version that is already live. `version_label` on a create or update annotates the version that write archives; it is not part of the config, so labelling a change is never itself a change.

| Operation | Endpoint |
| --- | --- |
| List versions, newest first | [`GET /api/v1/guardrails/{guardrail_id}/versions`](#list-archived-versions) |
| Fetch one version | `GET /api/v1/guardrails/{guardrail_id}/versions/{version}` |
| Roll back to a version | `POST /api/v1/guardrails/{guardrail_id}/versions/{version}/restore` |

**Restore appends, it does not rewind.** Restoring v1 of a guardrail at v2 writes v1's document back as **v3**, so records citing v2 still resolve. The restore runs through the ordinary update path (the archived document is re-validated), takes an optional `label`, and rolls back only the policy — `name`, `description` and the context binding are untouched.

Attachments reference the guardrail's **id**, not a version: a document edit takes effect immediately everywhere the id is attached. [Dry-run](#dry-run-evaluation) an edited document before writing it when the guardrail is attached at scale.

Guardrails have no release/canary layer, unlike agents: splitting traffic across two policies would mean deliberately under-enforcing one of them.

### Deletion

A guardrail cannot be deleted while it is attached: `DELETE /api/v1/guardrails/{guardrail_id}` returns `409` listing the tools, agents, and projects whose `guardrail_ids` still reference it. Each reference must be detached first — a `guardrails:DetachGuardrail` operation (see [Attachment](#attachment)) — so deletion can never do what detach permissions forbid. As defense-in-depth, a dangling reference encountered at evaluation time fails closed: the unresolvable guardrail evaluates as class **C**.

### Dry-run Evaluation

`POST /api/v1/guardrails/{guardrail_id}/evaluate` runs the full evaluation pipeline — the `class` expression, the guard, the context tool per `context_mode`, live `soat.*` resolution — against caller-supplied `args` and `guardrail_context`, and returns the exact [evaluation record](#evaluation-audit-record) a real call would produce. Nothing executes, no approval item is filed, no activity entry is written. Pass an optional `tool_id` to resolve `soat.tool.*`; an unresolvable `soat.*` key behaves exactly as at runtime (fail-closed).

This is the adoption path: preview a document's decisions against production-shaped calls **before** attaching it — or before editing a widely-attached one.

### Evaluation Audit Record

Every evaluation — execute, route-to-approval, block, or tripwire — writes a `guardrail_evaluation` activity entry (and stamps the generation/run record):

```json
{
  "kind": "guardrail_evaluation",
  "guardrail_id": "guard_V1StGXR8Z5jdHi6B",
  "guardrail_version": 3,
  "scope": "tool",
  "tool": "update-budget",
  "action": "update-budget",
  "class": "B",
  "decision": "execute",
  "guard_result": true,
  "context_source": "merged",
  "context_snapshot": {
    "args.amount": 450,
    "context.max_daily_budget": 500,
    "context.cost_ceiling": 1000,
    "soat.usage.cost_usd_24h": 812.4
  },
  "agent_id": "agent_V1StGXR8Z5jdHi6B",
  "orchestration_run_id": "orch_run_V1StGXR8Z5jdHi6B",
  "generation_id": "gen_V1StGXR8Z5jdHi6B"
}
```

- `tool` / `action` name the call being classified; both are `null` for a call with no tool in scope.
- `decision` is one of `execute` \| `route_to_approval` \| `blocked` \| `tripwire`.
- `class` is the resolved class; when the `class` expression returned an invalid value it is the applied `default_class`.
- `scope` records where this guardrail was attached: `project` \| `agent` \| `tool`. One record is written per applying guardrail; the enacted `decision` is the strictest across them.
- `context_source` records where the effective context came from: `caller` \| `tool` \| `merged` \| `none`.
- `guard_result` is the guard expression's boolean outcome; `null` when the document has no guard or the call did not classify as `B`.
- `context_snapshot` is a flat map of **only the vars the evaluation actually referenced**, keyed by fully-qualified path and frozen at evaluation-time value — enough to answer "why did this pass?" later, without recording unreferenced (possibly sensitive) context.

Evaluations that **changed the call's outcome** — `route_to_approval`, `blocked`, or `tripwire`, but **not** `execute` — are additionally mirrored into the [audit log](./audit-log.md#system-originated-entries) as a platform-originated entry (`action: guardrails:Evaluate`, `detail.kind: guardrail_evaluation`); a `route_to_approval` entry also carries the filed `approval_id`.

### Formation resource

Guardrails can be declared as a `guardrail` [formation](./formations.md) resource (`GuardrailResourceProperties`): `name`, `description`, `class`, `default_class`, `guard`, `escalate`, `context_tool_id`, `context_mode` — the same fields as [Create a guardrail](#create-a-guardrail), with the REST API's single `document` object flattened to top-level properties. `context_tool_id` may be a `{ "ref": "ResourceName" }` to a `tool` resource in the same template, and a tool or agent resource can attach the guardrail via `guardrail_ids: [{ "ref": "ResourceName" }]`, so a full gate deploys from one template. `class`/`default_class`/`guard`/`escalate` are recombined into a single `document` write on every create/update, so an update that omits one of them drops it (matching `PATCH /api/v1/guardrails/{guardrail_id}`'s full-replace semantics for `document`).

## Examples

### Create a guardrail

This guardrail governs the budget-update tool it is attached to: class **B** below 500, **C** at or above, executing autonomously only while 24h spend stays under 1000.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-guardrail \
  --name "Budget Update Guardrail" \
  --document '{
    "default_class": "C",
    "class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
    "guard": { "<": [{ "var": "soat.usage.cost_usd_24h" }, 1000] }
  }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.guardrails.createGuardrail({
  body: {
    name: 'Budget Update Guardrail',
    document: {
      default_class: 'C',
      class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
      guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/guardrails \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Budget Update Guardrail",
    "document": {
      "default_class": "C",
      "class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
      "guard": { "<": [{ "var": "soat.usage.cost_usd_24h" }, 1000] }
    }
  }'
```

</TabItem>
</Tabs>

### Dry-run a guardrail before attaching

Preview the decision the guardrail above would make for a production-shaped call — nothing executes, nothing is filed:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat evaluate-guardrail \
  --guardrail-id guard_V1StGXR8Z5jdHi6B \
  --args '{"amount": 450}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.guardrails.evaluateGuardrail({
  path: { guardrail_id: 'guard_V1StGXR8Z5jdHi6B' },
  body: { args: { amount: 450 } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/guardrails/guard_V1StGXR8Z5jdHi6B/evaluate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "args": { "amount": 450 } }'
```

</TabItem>
</Tabs>

The response is the would-be [evaluation record](#evaluation-audit-record) — here class **B** with a passing guard, `soat.usage.cost_usd_24h` resolved live:

```json
{
  "class": "B",
  "decision": "execute",
  "guard_result": true,
  "context_source": "none",
  "context_snapshot": {
    "args.amount": 450,
    "soat.usage.cost_usd_24h": 812.4
  }
}
```

### Attach a guardrail

A tool-scoped guardrail attaches to its **tool**, governing it for every agent that uses it. Attach to an **agent** instead (`soat update-agent --agent-id agent_01 --guardrail-ids …`) for a blanket posture over the agent's whole tool surface, or to a **project** (`soat update-project --project-id proj_01 --guardrail-ids …`) for a baseline over every agent in it — see [Attachment](#attachment).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-tool \
  --tool-id tool_01 \
  --guardrail-ids guard_V1StGXR8Z5jdHi6B guard_9f3Kd2Lm0PqRsT4u
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.tools.updateTool({
  path: { tool_id: 'tool_01' },
  body: { guardrail_ids: ['guard_V1StGXR8Z5jdHi6B', 'guard_9f3Kd2Lm0PqRsT4u'] },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/tools/tool_01 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"guardrail_ids": ["guard_V1StGXR8Z5jdHi6B", "guard_9f3Kd2Lm0PqRsT4u"]}'
```

</TabItem>
</Tabs>

### Pass guardrail context on a generation

The application supplies the `context.*` values guards evaluate over. If the guardrail also names a `context_tool_id`, the tool's output is combined over this object per `context_mode` at evaluation time.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id agent_01 \
  --messages '[{"role":"user","content":"Raise the campaign budget to 450"}]' \
  --guardrail-context '{"max_daily_budget": 500, "cost_ceiling": 1000}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.agents.createAgentGeneration({
  path: { agent_id: 'agent_01' },
  query: { wait: true },
  body: {
    prompt: 'Raise the campaign budget to 450',
    guardrail_context: { max_daily_budget: 500, cost_ceiling: 1000 },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/agents/agent_01/generate?wait=true \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Raise the campaign budget to 450",
    "guardrail_context": { "max_daily_budget": 500, "cost_ceiling": 1000 }
  }'
```

</TabItem>
</Tabs>

### List archived versions

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-guardrail-versions --guardrail-id guard_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.guardrails.listGuardrailVersions({
  path: { guardrail_id: 'guard_V1StGXR8Z5jdHi6B' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET https://api.example.com/api/v1/guardrails/guard_V1StGXR8Z5jdHi6B/versions \
  -H "Authorization: Bearer <admin-token>"
```

</TabItem>
</Tabs>
