---
description: "First-class action-class policies that classify each agent tool call — execute, require approval, or block — with non-LLM guard expressions and project / agent / tool attach scopes that compose stricter-wins."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Guardrails

Guardrails classify every tool call an agent makes into an action class — execute autonomously, route to human approval, or block — using deterministic, non-LLM guard expressions.

## Overview

A guardrail is a standalone, versioned resource, separate from [IAM policies](./policies.md): a policy decides whether a caller may invoke an endpoint; a guardrail decides whether an agent may take this action, with these arguments, in this context, without a human signing off. It maps tool calls to **action classes** (A/B/C/D) and gates class-B autonomy behind guard expressions evaluated after the model produces the call and before it executes.

Class-C actions route into the [approvals queue](./approvals.md), guards read spend from [usage metering](./usage.md), and expressions use the [JSON Logic](https://jsonlogic.com) evaluator that [orchestrations](./orchestrations.md) use. Tools, agents and projects each carry a `guardrail_ids` list, so a guardrail [attaches](#attachment) at any of those scopes; the strictest decision wins.

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

An immutable archive of a guardrail's configuration at one version; same shape and engine as [`AgentVersion`](./agents.md#versioning-and-staged-rollout).

| Field          | Type    | Description                                                                 |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `id`           | string  | `guard_ver_`-prefixed public ID of the archived version                     |
| `guardrail_id` | string  | The `guard_`-prefixed guardrail this version belongs to                     |
| `version`      | integer | The archived version number                                                 |
| `config`       | object  | The versioned surface at that version — today `{ document }` and nothing else |
| `label`        | string  | Optional human tag, e.g. `pre-tightening`; null when unset                   |
| `created_by`   | string  | Public ID of the user whose action produced this version; null when there was none |
| `created_at`   | string  | ISO 8601 timestamp                                                          |

Only the `document` is versioned; name, description and the context binding are metadata. One version number denotes one policy, which is what an [evaluation record](#evaluation-audit-record) cites.

## Key Concepts

### Attachment

A guardrail attaches through the `guardrail_ids` list on one of three resources; each scope can carry several:

- **Project** — every tool call by every agent in the project.
- **Agent** — every tool call the agent makes.
- **Tool** — that tool wherever it is used, by any agent.

Adding an id can only tighten the outcome, so it needs the carrying resource's update permission (`tools:UpdateTool`, `agents:UpdateAgent`, `projects:UpdateProject`). Removing an id can loosen posture, so it additionally requires `guardrails:DetachGuardrail`.

Every applying guardrail evaluates and the strictest decision wins, ordered `blocked` > `tripwire` > `route_to_approval` > `execute`; where several classify the same call as `B`, all their guards must pass. Composition is order-independent; `A` is the identity. One `guardrail_evaluation` record is written per guardrail evaluated.

### Action Classes

| Class | Meaning                | Behavior                                                                                     |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------- |
| **A** | Read-only / harmless   | Always execute; logged to the activity feed                                                  |
| **B** | Autonomous with a guard | Execute **iff the guard passes**; a failing guard trips fail-closed (or routes to approval — see [Tripwires](#tripwires-and-escalate)) |
| **C** | Human sign-off         | Files an [`ApprovalItem`](./approvals.md) (`origin: tool_call`); executes only on approval    |
| **D** | Forbidden              | The call is blocked at dispatch; the model receives a blocked tool result and continues its turn |

A `class` expression returning anything other than `"A"` / `"B"` / `"C"` / `"D"` resolves to `default_class` (default **C**). Mapping autonomy grades onto classes: [Layers are concerns, not autonomy levels](/docs/agent-system-layers#layers-are-concerns-not-autonomy-levels).

Class C uses the [approvals queue](./approvals.md)'s return-pending mechanics: the tool result is `{ "status": "pending_approval", "approval_id": …, "expires_at": … }` and the turn completes. Approval starts a continuation generation with the frozen (or edited) arguments; rejection executes nothing; expiry ends the chain unless the agent opts in ([Agents → Approval Expiry](./agents.md#approval-expiry)).

The document may carry `expires_in` (seconds): the sign-off window for a class-C approval it files (default 24h). When several guardrails apply, the strictest guardrail's `expires_in` wins, in agent tool dispatch and the [orchestration tool node](#orchestration-tool-nodes) alike.

### Classification

`class` is a literal (`{ "class": "C" }` always requires sign-off) or a single JSON Logic expression returning the class, evaluated over the same namespaces as guards (`args.*` / `context.*` / `runtime.*`). There is no rule list; anything other than a valid class falls through to `default_class`.

To gate several tools differently, create a guardrail per tool and [attach](#attachment) each to its tool rather than branching on `runtime.tool.name`. This example classifies a budget update **B** below a threshold and **C** at or above it:

```json
{
  "default_class": "C",
  "class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
  "guard": { "<=": [{ "var": "args.amount" }, { "var": "context.max_daily_budget" }] }
}
```

### Guards and Guardrail Context

`class` and `guard` are single JSON Logic expressions (the evaluator [orchestration](./orchestrations.md) mappings use); compose with `if`/`and`/`or`/`!`, not arrays. Every `var` resolves against three namespaces:

| Namespace   | Source                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `args.*`    | The proposed call's arguments (post preset-merge — the same frozen arguments an [approval item](./approvals.md) records) |
| `context.*` | The **effective guardrail context** — application-owned, see below                                             |
| `runtime.*`    | Platform-computed values (fixed catalog below); reserved — never writable by the caller or the context tool     |

The caller passes a free-form `guardrail_context` object on the generation request or orchestration-run start; the platform never interprets it. A guardrail may also name a `context_tool_id`, an ordinary [tool](./tools.md) the platform calls immediately before classifying each gated call, so long-parked runs read fresh context. `context_mode` combines the two: `merge` (default) shallow-merges top-level keys over the caller-supplied object, the tool's value winning; `replace` substitutes it entirely.

The context tool runs under the calling agent's credentials (same project scoping and secret resolution); its result never enters the model context. An inaccessible tool fails closed. The call has a per-call timeout and a short per-`(project, guardrail)` TTL cache.

The `runtime.*` catalog (window suffixes `_1h` / `_24h` / `_7d` / `_30d` are rolling and end at evaluation time):

| Key                                                        | Type    | Source                                                  |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `runtime.action` / `runtime.tool.id` / `runtime.tool.name`          | string  | The call being classified                               |
| `runtime.agent.id` / `runtime.project.id`                        | string  | Evaluation identity                                     |
| `runtime.orchestration_run.node_attempt` / `runtime.orchestration_run.tool_calls`            | integer | Current [orchestration run](./orchestrations.md) state  |
| `runtime.activity.actions_1h` / `runtime.activity.actions_24h`   | integer | [Activity feed](./activity.md) (per project)            |
| `runtime.usage.cost_usd_1h` / `_24h` / `_7d` / `_30d`         | number  | [Usage metering](./usage.md) (per project)              |
| `runtime.usage.tokens_24h` / `runtime.usage.tokens_30d`          | integer | [Usage metering](./usage.md) (per project)              |
| `runtime.usage.orchestration_run_tokens` / `runtime.usage.orchestration_run_cost_usd`        | number  | [Usage metering](./usage.md) (**per run**, cumulative)  |

`runtime.activity.actions_1h` / `actions_24h` count this project's `action_executed` entries on the [activity feed](./activity.md#the-feed-as-a-guardrail-signal) over the window, read live. An empty feed reads `0`; only a failing query fails closed.

`runtime.usage.orchestration_run_tokens` / `orchestration_run_cost_usd` sum only the current [orchestration run](./orchestrations.md)'s usage events, read live; see [Per-run spend ceilings](#per-run-spend-ceilings).

**A cost key resolves to `null` when its spend cannot be priced.** `SUM(cost_usd)` ignores unpriced events, so a window that metered LLM usage and priced none of it would pass every ceiling. `runtime.usage.cost_usd_*` and `runtime.usage.orchestration_run_cost_usd` report `null` instead, which fails the guard: the same verdict a `cost_usd` [quota](./quotas.md) answers with `QUOTA_UNENFORCEABLE`, cleared once the models carry [price book](./usage.md) rows. Not triggered by a window with no LLM usage (reads `0`), unpriced **embeddings** (their rate is deployment configuration, not a tenant price row), or a partly priced window (any priced LLM event clears it; unpriced events count as zero). The partly priced gap is reported as a [`quota_unpriced` exception](./quotas.md#unpriced-usage) on the project's `cost_usd` [quota](./quotas.md) naming the rows to price.

**Fail-closed at both ends.** At write time, a `var` outside the three namespaces, or a `runtime.*` key outside the catalog, is rejected with `400`. At evaluation time, a `context.*` key absent from the effective context, a context-tool failure or timeout, or an unresolvable `runtime.*` provider fails closed: in `class` the result is `default_class`; in `guard` it counts as a failed guard and tripwire semantics apply.

**Variable casing.** `guardrail_context` (and a dry-run's `args`) keys pass through verbatim, with no snake↔camel conversion; snake_case is recommended (it matches the `runtime.*` catalog): `{ "var": "context.max_daily_budget" }` reads a supplied `max_daily_budget`.

**Missing keys.** JSON Logic coerces an absent `var` to a falsy, zero-ish value, so `{ "<": [{ "var": "args.amount" }, 500] }` is `true` when `args.amount` is absent. Test presence explicitly when that must not reach the permissive branch: `{ "and": [{ "var": "args.amount" }, { "<": [{ "var": "args.amount" }, 500] }] }`.

### Tripwires and `escalate`

A failing class-B guard is a **tripwire**: by default it aborts the action and files an exception. `escalate: true` routes the call to the [approvals queue](./approvals.md) instead.

`escalate` is per-guardrail: a failing guard yields `tripwire` without it and `route_to_approval` with it; `tripwire` outranks `route_to_approval` in the [decision ordering](#attachment).

### Per-run spend ceilings

`runtime.usage.orchestration_run_tokens` and `runtime.usage.orchestration_run_cost_usd` expose the current [orchestration run](./orchestrations.md)'s cumulative metered spend, live, so a ceiling trips mid-run on the call that crosses it, where a project-windowed guard would barely move.

Give the ceiling itself as `guardrail_context` (or a context tool) so one guardrail serves every run:

```bash
soat create-guardrail \
  --name "Per-run token ceiling" \
  --document '{
    "class": "B",
    "guard": {
      "<": [
        { "var": "runtime.usage.orchestration_run_tokens" },
        { "var": "context.action_token_ceiling" }
      ]
    }
  }'
```

Attach it to the tools the run dispatches; the guard fails before the tool runs. Swap `orchestration_run_tokens` for `orchestration_run_cost_usd` to cap dollars.

- **Fail-closed outside a run.** Both keys are unresolvable when no run is in scope (they do not read as `0`), so a per-run ceiling attached at project scope trips on plain agent calls too; attach at tool scope unless that is intended.
- **Metering granularity is the resolution.** Counters advance as each provider call is metered ([usage coverage](./usage.md#coverage)), so a ceiling trips on the first gated call after it is crossed; a single over-budget call can still complete.

### Client Tools

[Client tools](./tools.md) are gated at the `requires_action` handoff: class **A** and a passing **B** hand the call to the client; class **C** files the approval item first and hands off only on approval; class **D** blocks the handoff; a tripwire aborts before anything reaches the client. The platform cannot observe what the client does after.

### Orchestration tool nodes

An [orchestration](./orchestrations.md) `tool` node is gated at dispatch with no agent in scope, so it composes only the **project + tool** scopes (`agentId`/`generationId` are `null` on the evaluation identity and audit record). The strictest decision is enacted as:

- **A / passing B** — the tool executes with the (cleaned) node inputs.
- **C** — the run parks on the node with a `requires_action` of `type: "approval"`, filing an [`ApprovalItem`](./approvals.md) (`origin: node`). On approval the node re-dispatches with the frozen (or edited) arguments without re-evaluating the guardrail; on rejection or expiry the tool never runs and only a matching decision edge (`condition: "rejected"` / `"expired"`) follows.
- **D / tripwire** — a routable `blocked` outcome, not a run failure: the node records a `{ status, reason }` artifact and branches by label, so an edge conditioned on `blocked` (or `tripwire`) routes to a fallback path. An unlabeled success edge does not follow a blocked node.

### Direct calls and pipeline steps

A tool-scoped guardrail also gates the dispatches with no agent and no orchestration graph: [`POST /api/v1/tools/{tool_id}/call`](/docs/api/tools/call-tool), every step of a `pipeline` tool, a [trigger](./triggers.md) whose target is a tool, an [ingestion rule](./ingestion-rules.md) converter, an [eval](./evaluations.md) tool scorer, and a `tool_id` embedded in a message. These compose **project + tool** scope only, and none can await a decision:

- **A / passing B** — the call runs with the cleaned arguments.
- **C / D / tripwire** — refused with `422 TOOL_DISPATCH_FAILED`, whose `meta` carries the `tool_id` and the `outcome` that settled it. Inside a pipeline the step's own `PIPELINE_STEP_FAILED` names the settled step.

A gated pipeline is adjudicated before its first step runs, so a refusal never leaves half a pipeline applied. Reach an approval-gated tool through an agent or an orchestration, which can park on the sign-off.

Not gated: a guardrail's own [context fetch](#guards-and-guardrail-context), and an [approved](./approvals.md) call (the filing guardrail already classified it and a human signed off on those exact arguments).

### Running a tighter posture in one project

There is no override resource: [attach](#attachment) a tighter guardrail at the project scope (`{ "class": "C" }` forces sign-off on every call its agents make) or at one tool's scope. Stricter-wins means it can only tighten; other projects are untouched.

### Versioning

The policy uses the append-only archive that backs [agent versions](./agents.md#versioning-and-staged-rollout). Version 1 is written on create; every write that changes the `document` increments `version` and archives a `GuardrailVersion`. Approval items, activity entries and exceptions record the governing version.

Three writes archive nothing: a metadata-only edit (`name`, `description`, `context_tool_id`, `context_mode`); re-writing the document already held (compared structurally); restoring the version already live. `version_label` on a create or update annotates the version that write archives and is not itself a change.

| Operation | Endpoint |
| --- | --- |
| List versions, newest first | [`GET /api/v1/guardrails/{guardrail_id}/versions`](#list-archived-versions) |
| Fetch one version | [`GET /api/v1/guardrails/{guardrail_id}/versions/{version}`](/docs/api/guardrails/get-guardrail-version) |
| Roll back to a version | [`POST /api/v1/guardrails/{guardrail_id}/versions/{version}/restore`](/docs/api/guardrails/restore-guardrail-version) |

**Restore appends.** Restoring v1 of a guardrail at v2 writes v1's document as **v3**, so records citing v2 still resolve. It runs through the ordinary update path (re-validated), takes an optional `label`, and rolls back only the policy; `name`, `description` and the context binding are untouched.

Attachments reference the id, not a version, so a document edit takes effect everywhere at once; [dry-run](#dry-run-evaluation) it first. There is no release/canary layer: splitting traffic across two policies would under-enforce one.

### Deletion

A guardrail cannot be deleted while attached: [`DELETE /api/v1/guardrails/{guardrail_id}`](/docs/api/guardrails/delete-guardrail) returns `409` listing the tools, agents and projects whose `guardrail_ids` reference it. Each must be detached first (`guardrails:DetachGuardrail`, see [Attachment](#attachment)). A dangling reference met at evaluation time fails closed as class **C**.

### Dry-run Evaluation

[`POST /api/v1/guardrails/{guardrail_id}/evaluate`](/docs/api/guardrails/evaluate-guardrail) runs the full evaluation pipeline (`class`, guard, context tool per `context_mode`, live `runtime.*`) against caller-supplied `args` and `guardrail_context`, and returns the [evaluation record](#evaluation-audit-record) a real call would produce. Nothing executes or is filed. Pass an optional `tool_id` to resolve `runtime.tool.*`; an unresolvable `runtime.*` key fails closed as at runtime. Use it before attaching a document, or before editing a widely attached one.

### Evaluation Audit Record

Every evaluation writes a `guardrail_evaluation` activity entry and stamps the generation/run record:

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
    "runtime.usage.cost_usd_24h": 812.4
  },
  "agent_id": "agent_V1StGXR8Z5jdHi6B",
  "orchestration_run_id": "orch_run_V1StGXR8Z5jdHi6B",
  "generation_id": "gen_V1StGXR8Z5jdHi6B"
}
```

- `tool` / `action` name the call being classified; both are `null` for a call with no tool in scope.
- `decision` is one of `execute` \| `route_to_approval` \| `blocked` \| `tripwire`.
- `class` is the resolved class; when the `class` expression returned an invalid value it is the applied `default_class`.
- `scope` records where this guardrail was attached: `project` \| `agent` \| `tool`. One record per applying guardrail; the enacted `decision` is the strictest across them.
- `context_source` records where the effective context came from: `caller` \| `tool` \| `merged` \| `none`.
- `guard_result` is the guard expression's boolean outcome; `null` when the document has no guard or the call did not classify as `B`.
- `context_snapshot` is a flat map of only the vars the evaluation referenced, keyed by fully-qualified path and frozen at evaluation-time value; unreferenced (possibly sensitive) context is never recorded.

Evaluations that changed the call's outcome (`route_to_approval`, `blocked`, `tripwire`; not `execute`) are also mirrored into the [audit log](./audit-log.md#system-originated-entries) as a platform-originated entry (`action: guardrails:Evaluate`, `detail.kind: guardrail_evaluation`); a `route_to_approval` entry also carries the filed `approval_id`.

### Formation resource

A `guardrail` [formation](./formations.md) resource (`GuardrailResourceProperties`) takes `name`, `description`, `class`, `default_class`, `guard`, `escalate`, `context_tool_id`, `context_mode`: the fields of [Create a guardrail](#create-a-guardrail) with `document` flattened to top-level properties. `context_tool_id` may be a `{ "ref": "ResourceName" }` to a `tool` resource in the same template, and a tool or agent resource can attach it via `guardrail_ids: [{ "ref": "ResourceName" }]`. `class`/`default_class`/`guard`/`escalate` are recombined into one `document` write on every create/update, so an update omitting one drops it (matching [`PATCH /api/v1/guardrails/{guardrail_id}`](/docs/api/guardrails/update-guardrail)'s full-replace semantics for `document`).

## Examples

### Create a guardrail

Class **B** below 500, **C** at or above; executes autonomously only while 24h spend stays under 1000.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-guardrail \
  --name "Budget Update Guardrail" \
  --document '{
    "default_class": "C",
    "class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
    "guard": { "<": [{ "var": "runtime.usage.cost_usd_24h" }, 1000] }
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
      guard: { '<': [{ var: 'runtime.usage.cost_usd_24h' }, 1000] },
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
      "guard": { "<": [{ "var": "runtime.usage.cost_usd_24h" }, 1000] }
    }
  }'
```

</TabItem>
</Tabs>

### Dry-run a guardrail before attaching

Preview the decision the guardrail above would make; nothing executes or is filed:

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

The response is the would-be [evaluation record](#evaluation-audit-record): class **B**, passing guard, `runtime.usage.cost_usd_24h` resolved live:

```json
{
  "class": "B",
  "decision": "execute",
  "guard_result": true,
  "context_source": "none",
  "context_snapshot": {
    "args.amount": 450,
    "runtime.usage.cost_usd_24h": 812.4
  }
}
```

### Attach a guardrail

Attach to a tool (below), to an agent (`soat update-agent --agent-id agent_01 --guardrail-ids …`) or to a project (`soat update-project --project-id proj_01 --guardrail-ids …`); see [Attachment](#attachment).

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

The application supplies the `context.*` values; a `context_tool_id`'s output is combined over this object per `context_mode`.

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
    messages: [{ role: 'user', content: 'Raise the campaign budget to 450' }],
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
    "messages": [{ "role": "user", "content": "Raise the campaign budget to 450" }],
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
