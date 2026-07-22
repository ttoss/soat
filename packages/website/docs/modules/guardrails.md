---
description: "First-class action-class policies that classify each agent tool call — execute, require approval, or block — with non-LLM guard expressions and project / agent / tool attach scopes that compose stricter-wins."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Guardrails

Guardrails classify every tool call an agent makes into an action class — execute autonomously, route to human approval, or block — using deterministic, non-LLM guard expressions.

## Overview

A guardrail is a **standalone, versioned resource** — separate from [IAM policies](./policies.md), which it deliberately does not touch. Where an IAM policy answers _"may this caller invoke this endpoint?"_ at request time, a guardrail answers a different question at a different layer: _"may this agent take **this specific action, with these arguments, in this context**, on its own — or must a human sign off?"_. A guardrail maps tool calls to **action classes** (A/B/C/D) and gates class-B autonomy behind guard expressions evaluated at the tool-execution boundary — after the model produces the call and before anything touches the outside world. There is no LLM in the evaluation path.

Guardrails are the platform's **single tool-call gating mechanism**: a class-C action routes into the same [approvals queue](./approvals.md) with the same return-pending / continuation mechanics, guards read spend from [usage metering](./usage.md), and expressions use the shared [JSON Logic](https://jsonlogic.com) evaluator that [orchestrations](./orchestrations.md) already use. Tools, agents, and projects each carry a `guardrail_ids` list, so a guardrail [attaches](#attachment) at any of those three scopes and several can apply to one call at once; when they do, the strictest decision wins.

A guardrail is a **reusable template**: defined once, it can govern many tools and agents. The three attach scopes are how a fleet layers posture without forking — a broad baseline attached at the **project** scope, tightened locally at the **agent** or **tool** scope. Because composition is stricter-wins, every added guardrail can only tighten the result, never loosen it: a project-scoped baseline is a floor that agent- and tool-scoped guardrails can raise but never lower.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Guardrail

| Field         | Type    | Description                                                        |
| ------------- | ------- | ------------------------------------------------------------------ |
| `id`          | string  | Public identifier prefixed with `guard_`                           |
| `name`        | string  | Human-readable name                                                |
| `description` | string  | Optional description                                               |
| `version`     | integer | Incremented on every `document` write; prior versions are archived |
| `document`    | object  | The action-class document (see below)                              |
| `context_tool_id` | string | Optional [tool](./tools.md) the platform calls at evaluation time to fetch fresh [guardrail context](#guards-and-guardrail-context) |
| `context_mode` | string | How tool-fetched context combines with the caller-supplied context: `merge` (default) or `replace` |
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

| Field          | Type    | Description                                          |
| -------------- | ------- | --------------------------------------------------- |
| `guardrail_id` | string  | The `guard_`-prefixed guardrail this version belongs to |
| `version`      | integer | The archived version number                         |
| `document`     | object  | The exact document that governed at that version    |
| `created_at`   | string  | ISO 8601 timestamp                                  |

A guardrail is attached by adding its `id` to the `guardrail_ids` list on a [tool](./tools.md), an [agent](./agents.md), or a [project](./projects.md) — see [Attachment](#attachment).

## Key Concepts

### Attachment

A guardrail attaches through a `guardrail_ids` array on one of three resources — it is **not** attached the way IAM policies attach to users and API keys. Every field is a list, so each scope can carry several composable guardrails (a budget guardrail, a PII guardrail, a rate-limit guardrail) instead of one monolithic document:

- **On a project** — every guardrail in the project's `guardrail_ids` governs **every** tool call by **every** agent in the project. This is the baseline / central-mandate scope: the floor for the whole tenant, which narrower scopes can only raise.
- **On an agent** — governs **every** tool call the agent makes, across all its bindings. `default_class` covers any tool nobody thought about.
- **On a tool** — governs that tool **wherever it is used**, by any agent. A dangerous tool carries its own gate; binding it to a new agent can never silently escape classification.

**Attach is cheap, detach is gated.** Adding an id to a `guardrail_ids` list can only tighten the outcome, so it needs only the carrying resource's update permission (`tools:UpdateTool`, `agents:UpdateAgent`, `projects:UpdateProject`). Removing an id — at **any** of the three scopes — is the one attachment operation that can loosen posture, so it additionally requires `guardrails:DetachGuardrail`. `tools:UpdateTool` alone can add a guardrail to a tool but never strip one off; the same asymmetry holds on agents and projects, so the floor can't be silently lowered from any scope.

Every guardrail that applies to a call — each of the project's, the agent's, and the tool's — **evaluates, and the strictest decision across all of them wins**, ordered `blocked` > `tripwire` > `route_to_approval` > `execute`; where several classify the same call as `B`, **all their guards must pass**. Composition can therefore only tighten, and it is order-independent — `A` is the identity, so a guardrail that returns `"A"` for a call simply defers to the others. This is what replaces a bespoke per-project override: to run a stricter posture in one project, attach a tighter guardrail at that project's (or its agents'/tools') scope; stricter-wins guarantees it can only tighten, and other projects are untouched. One `guardrail_evaluation` record is written per guardrail evaluated.

### Action Classes

| Class | Meaning                | Behavior                                                                                     |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------- |
| **A** | Read-only / harmless   | Always execute; logged to the activity feed                                                  |
| **B** | Autonomous with a guard | Execute **iff the guard passes**; a failing guard trips fail-closed (or routes to approval — see [Tripwires](#tripwires-and-escalate)) |
| **C** | Human sign-off         | Files an [`ApprovalItem`](./approvals.md) (`origin: tool_call`); executes only on approval    |
| **D** | Forbidden              | The call is blocked at dispatch; the model receives a blocked tool result and continues its turn |

A `class` expression that returns anything other than `"A"` / `"B"` / `"C"` / `"D"` — `null` from a missing key, a typo, a number — resolves to `default_class`, which itself defaults to **C**: anything nobody classified requires a human. Fail-closed is the invariant: a misconfigured or absent classification never grants autonomy.

Class-C interception runs in the platform's tool-dispatch path with the return-pending mechanics the approval queue already defines: the call returns `{ "status": "pending_approval", "approval_id": …, "expires_at": … }` as the tool result, the turn completes normally, and resolution starts a continuation generation that executes the frozen (or edited) arguments — including [duplicate-proposal dedup](./approvals.md#data-model) and the model-visible `approval_*` justification fields.

### Classification

`class` is either a literal — a guardrail attached to a tool that always requires sign-off is just `{ "class": "C" }` — or a **single JSON Logic expression** that returns the class. The expression evaluates over the same three namespaces as guards (`args.*` / `context.*` / `soat.*`), so the class can depend on the call's arguments or runtime context. There is no rule list and no matching order: one expression, one result.

A guardrail reasons about **this** call, not about which tool it is. To gate several tools differently, create a guardrail per tool and [attach](#attachment) each to its tool — they compose, rather than branching on `soat.tool.name` inside one agent-level document. The example below classifies a budget-update call **B** below a threshold and **C** at or above it — just an `if` over `args`:

```json
{
  "default_class": "C",
  "class": { "if": [{ "<": [{ "var": "args.amount" }, 500] }, "B", "C"] },
  "guard": { "<=": [{ "var": "args.amount" }, { "var": "context.max_daily_budget" }] }
}
```

Anything the expression doesn't account for falls through to `default_class` (see [Action Classes](#action-classes)).

### Guards and Guardrail Context

Both `class` and `guard` are **single JSON Logic expressions** — the same evaluator [orchestration](./orchestrations.md) mappings use — with no `eval` and no LLM in the path. JSON Logic composes on its own (`{ "if": [...] }`, `{ "and": [...] }`, `{ "or": [...] }`, `{ "!": ... }`), so there are no rule or guard arrays. Every `var` in either expression resolves against exactly three namespaces:

| Namespace   | Source                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `args.*`    | The proposed call's arguments (post preset-merge — the same frozen arguments an [approval item](./approvals.md) records) |
| `context.*` | The **effective guardrail context** — application-owned, see below                                             |
| `soat.*`    | Platform-computed values (fixed catalog below); reserved — never writable by the caller or the context tool     |

**Guardrail context is application-owned.** The caller passes a free-form `guardrail_context` object on the generation request or orchestration-run start; the platform never interprets it — it only evaluates guards over it. For long-lived work (an orchestration run can park at an approval node for days), a run-start snapshot goes stale, so a guardrail may also name a `context_tool_id` — an ordinary [tool](./tools.md) (typically HTTP) the platform calls at **evaluation time**, immediately before classifying each gated tool call. `context_mode` controls how the two combine:

- `merge` (default) — shallow merge of top-level keys over the caller-supplied object; the tool's value wins on conflict (fresher data beats run-start data)
- `replace` — the tool's output substitutes the caller-supplied object entirely

The context tool executes **under the calling agent's credentials**, exactly like any other tool call by that agent — same project scoping, same secret resolution — so a guardrail can never read data the agent itself could not reach. The one difference is who initiates it: the platform's dispatch path invokes it, the model never sees it, calls it, or influences its output, and its result never enters the model context. If the agent cannot access the tool, the call fails and the standard fail-closed rule applies. The call is bounded — a per-call timeout and a short per-`(project, guardrail)` TTL cache.

The `soat.*` catalog (windows are baked into the key name — a fixed suffix set `_1h` / `_24h` / `_7d` / `_30d`, each rolling and ending at evaluation time):

| Key                                                        | Type    | Source                                                  |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `soat.action` / `soat.tool.id` / `soat.tool.name`          | string  | The call being classified                               |
| `soat.agent.id` / `soat.project.id`                        | string  | Evaluation identity                                     |
| `soat.run.node_attempt` / `soat.run.tool_calls`            | integer | Current [orchestration run](./orchestrations.md) state  |
| `soat.activity.actions_1h` / `soat.activity.actions_24h`   | integer | [Activity feed](./approvals.md) (per project)           |
| `soat.usage.cost_usd_1h` / `_24h` / `_7d` / `_30d`         | number  | [Usage metering](./usage.md) (per project)              |
| `soat.usage.tokens_24h` / `soat.usage.tokens_30d`          | integer | [Usage metering](./usage.md) (per project)              |

`soat.activity.*` resolves from the activity feed; on a deployment where the feed is not yet populated, those keys are unresolvable and the standard fail-closed rule below applies — a guard referencing them will not pass until the feed is live.

**Fail-closed at both ends.** At write time, a document referencing a `var` outside the three namespaces — or a `soat.*` key outside the catalog — is rejected with `400`, never silently `null` at runtime. At evaluation time, an expression referencing a `context.*` key absent from the effective context, a context-tool failure or timeout, or a `soat.*` provider that cannot resolve all fail closed: in `class`, the result resolves to `default_class`; in `guard`, it counts as a **failed guard** and tripwire semantics apply. Forgetting to supply context tightens the posture; it never loosens it.

**Variable casing.** `guardrail_context` (and a dry-run's `args`) is an application-owned bag — the platform passes its keys through **verbatim**, without the snake↔camel conversion applied to the rest of the API. A `var` therefore reads exactly the key you supplied: author both the document path and the context key in the same case. Snake_case is recommended (it matches the `soat.*` catalog and every example here), so `{ "var": "context.max_daily_budget" }` reads a supplied `max_daily_budget`. A key sent as `maxDailyBudget` would only be read by `{ "var": "context.maxDailyBudget" }`.

**Missing keys and comparisons.** JSON Logic coerces an absent `var` to a falsy, zero-ish value, so a bare comparison treats a **missing** argument as `0`: `{ "<": [{ "var": "args.amount" }, 500] }` is `true` when `args.amount` is absent, and the call takes the `< 500` branch. When a missing argument must **not** reach the permissive branch, test presence explicitly — e.g. `{ "and": [{ "var": "args.amount" }, { "<": [{ "var": "args.amount" }, 500] }] }` — rather than relying on the comparison alone.

### Tripwires and `escalate`

A failing class-B guard is a **tripwire**: by default it aborts the action and files an exception rather than silently downgrading — a runaway loop hits a hard, non-LLM stop. A document with `escalate: true` opts into the softer behavior: a failing guard routes the call to the [approvals queue](./approvals.md) for a human decision instead of aborting.

`escalate` is **per-guardrail**: a failing guard yields that guardrail's own decision — `tripwire` without `escalate`, `route_to_approval` with it — and the strictest decision across all applying guardrails still wins. If two guardrails classify the same call `B` and both guards fail, one with `escalate: true` and one without, the tripwire prevails (`tripwire` outranks `route_to_approval` in the [decision ordering](#attachment)): opting one guardrail into escalation never softens another's hard stop.

### Client Tools

Guardrails classify calls to [client tools](./tools.md) like any other. Because actuation happens on the client, the gate sits at the `requires_action` **handoff** rather than at server-side execution: class **A** and a passing **B** hand the call to the client as usual; class **C** files the approval item first, and the handoff happens only on approval; class **D** blocks the handoff and the model receives the blocked tool result; a tripwire aborts before anything reaches the client. The platform cannot observe what the client does after the handoff — the guardrail governs whether the call is released to the client at all.

### Orchestration tool nodes

An [orchestration](./orchestrations.md) `tool` node is gated at dispatch just like an agent tool call, but with no agent in scope it composes only the **project + tool** scopes (`agentId`/`generationId` are `null` on the evaluation identity and audit record). The strictest decision is enacted in orchestration terms:

- **A / passing B** — the tool executes with the (cleaned) node inputs.
- **C** — the run **parks** on the node with a `requires_action` of `type: "approval"`, filing an [`ApprovalItem`](./approvals.md) (`origin: node`) carrying the frozen arguments. On approval the node re-dispatches the tool with the frozen (or edited) arguments — the guardrail is **not** re-evaluated — and the run continues down its success edge; on rejection or expiry the tool never runs and only a matching decision edge (`condition: "rejected"` / `"expired"`) follows.
- **D / tripwire** — a **routable `blocked` outcome**, not a run failure: the node records a `{ status, reason }` artifact and branches by label, so an edge conditioned on `blocked` (or `tripwire`) routes to a fallback path. An unlabeled success edge does **not** auto-follow a blocked node.

### Running a tighter posture in one project

There is no separate override resource. A project runs a stricter posture than the fleet by [attaching](#attachment) a tighter guardrail at the **project** scope — `{ "class": "C" }` on the project forces sign-off on every call its agents would otherwise have executed, and stricter-wins guarantees it can only tighten what the agent- and tool-scoped guardrails already decided. To tighten just one tool, attach the stricter guardrail to that tool instead of the whole project. Either way, other projects — which don't carry that attachment — are unchanged, and because every layer composes by stricter-wins, a tenant can raise the floor but never lower it.

### Versioning

Every write to a guardrail's `document` increments `version` and archives the prior document as a `GuardrailVersion`. Approval items, activity entries, and exceptions record the version that governed them, so the audit chain survives edits. Fetch the exact governing document with [`GET /api/v1/guardrails/{guardrail_id}/versions/{version}`](#fetch-an-archived-version).

Attachments reference the guardrail's **id**, not a version: a document edit takes effect immediately on every tool, agent, and project that carries the id. [Dry-run](#dry-run-evaluation) an edited document before writing it when the guardrail is attached at scale.

### Deletion

A guardrail cannot be deleted while it is attached: `DELETE /api/v1/guardrails/{guardrail_id}` returns `409` listing the tools, agents, and projects whose `guardrail_ids` still reference it. Each reference must be detached first — a `guardrails:DetachGuardrail` operation (see [Attachment](#attachment)) — so deletion can never do what detach permissions forbid. As defense-in-depth, a dangling reference encountered at evaluation time fails closed: the unresolvable guardrail evaluates as class **C**.

### Dry-run Evaluation

`POST /api/v1/guardrails/{guardrail_id}/evaluate` runs the full evaluation pipeline — the `class` expression, the guard, the context tool per `context_mode`, live `soat.*` resolution — against caller-supplied `args` and `guardrail_context`, and returns the exact [evaluation record](#evaluation-audit-record) a real call would produce. Nothing executes, no approval item is filed, and no activity entry is written. Pass an optional `tool_id` to resolve `soat.tool.*`; any `soat.*` key that cannot resolve behaves exactly as at runtime (fail-closed).

This is the adoption path: preview a document's decisions against production-shaped calls **before** attaching it — or before editing a widely-attached one — so the first attach of a `default_class: C` baseline doesn't flood the [approvals queue](./approvals.md) unrehearsed.

### Evaluation Audit Record

Every evaluation — execute, route-to-approval, block, or tripwire — writes a `guardrail_evaluation` activity entry (and stamps the generation/run record) capturing the governing `guardrail_version`, the classification, the guard outcome, and provenance:

```json
{
  "kind": "guardrail_evaluation",
  "guardrail_id": "guard_V1StGXR8Z5jdHi6B",
  "guardrail_version": 3,
  "scope": "tool",
  "tool": "update-budget",
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
  "run_id": "orch_run_V1StGXR8Z5jdHi6B",
  "generation_id": "gen_V1StGXR8Z5jdHi6B"
}
```

- `decision` is one of `execute` \| `route_to_approval` \| `blocked` \| `tripwire`.
- `class` is the resolved class; when the `class` expression returned an invalid value it is the applied `default_class`.
- `scope` records where this guardrail was attached: `project` \| `agent` \| `tool`. One record is written per applying guardrail, so a call gated at several scopes produces several records; the enacted `decision` is the strictest across them.
- `context_source` records where the effective context came from: `caller` \| `tool` \| `merged` \| `none`.
- `guard_result` is the guard expression's boolean outcome; `null` when the document has no guard or the call did not classify as `B`.
- `context_snapshot` is a flat map of **only the vars the evaluation actually referenced** — every `var` in the `class` and `guard` expressions, keyed by its fully-qualified path (`args.*` / `context.*` / `soat.*`) and frozen at its evaluation-time value. The full `guardrail_context` may carry many more keys; those are not recorded. This is the only way to answer "why did this pass?" after the application's context (or platform usage counters) have moved on, while keeping the record small and free of unreferenced — possibly sensitive — context.

### Formation resource

Guardrails can be declared as a `guardrail` [formation](./formations.md) resource (`GuardrailResourceProperties`): `name`, `description`, `class`, `default_class`, `guard`, `escalate`, `context_tool_id`, `context_mode` — the same fields as [Create a guardrail](#create-a-guardrail), with the REST API's single `document` object flattened to top-level properties. `context_tool_id` may be a `{ "ref": "ResourceName" }` to a `tool` resource declared in the same template, resolved to its physical id at deploy time. A tool or agent resource in the same template can then attach it via `guardrail_ids: [{ "ref": "ResourceName" }]`, so a full gate — guardrail plus the tools/agents it governs — deploys from one template. `class`/`default_class`/`guard`/`escalate` are recombined into a single `document` write on every create/update, so an update that omits one of them drops it rather than merging (matching `PATCH /api/v1/guardrails/{guardrail_id}`'s full-replace semantics for `document`).

## Examples

### Create a guardrail

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

This guardrail governs one tool (the budget-update tool it is attached to): class **B** below 500, **C** at or above, and it executes autonomously only while 24h spend stays under 1000.

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

A tool-scoped guardrail like the one above attaches to its **tool**, so it governs that tool for every agent that uses it. Attach to an **agent** instead (`soat update-agent --agent-id agent_01 --guardrail-ids …`) for a blanket posture over the agent's whole tool surface, or to a **project** (`soat update-project --project-id proj_01 --guardrail-ids …`) for a baseline over every agent in it. All three fields are **lists**, so several guardrails compose on one surface (see [Attachment](#attachment)).

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

### Run a tighter posture in one project

There is no override resource — a project runs a stricter posture by attaching a tighter guardrail at its **project** scope. Here `guard_9f3Kd2Lm0PqRsT4u` is an always-`{ "class": "C" }` guardrail; attaching it to `proj_ABC` makes **every** tool call in that project require sign-off, on top of whatever the agent- and tool-scoped guardrails already decided. Stricter-wins means it can only tighten, and other projects — which don't carry the attachment — are unchanged. (To tighten just one tool, attach it to that tool instead of the project.)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project \
  --project-id proj_ABC \
  --guardrail-ids guard_9f3Kd2Lm0PqRsT4u
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.projects.updateProject({
  path: { project_id: 'proj_ABC' },
  body: { guardrail_ids: ['guard_9f3Kd2Lm0PqRsT4u'] },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/projects/proj_ABC \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "guardrail_ids": ["guard_9f3Kd2Lm0PqRsT4u"] }'
```

</TabItem>
</Tabs>

### Pass guardrail context on a generation

The application supplies the `context.*` values guards evaluate over. If the guardrail also names a `context_tool_id`, the tool's output is combined over this object per `context_mode` at evaluation time.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation \
  --agent-id agent_01 \
  --prompt "Raise the campaign budget to 450" \
  --guardrail-context '{"max_daily_budget": 500, "cost_ceiling": 1000}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.agents.createAgentGeneration({
  path: { agent_id: 'agent_01' },
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
curl -X POST https://api.example.com/api/v1/agents/agent_01/generate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Raise the campaign budget to 450",
    "guardrail_context": { "max_daily_budget": 500, "cost_ceiling": 1000 }
  }'
```

</TabItem>
</Tabs>

### Fetch an archived version

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-guardrail-version --guardrail-id guard_V1StGXR8Z5jdHi6B --version 3
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.guardrails.getGuardrailVersion({
  path: { guardrail_id: 'guard_V1StGXR8Z5jdHi6B', version: 3 },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET https://api.example.com/api/v1/guardrails/guard_V1StGXR8Z5jdHi6B/versions/3 \
  -H "Authorization: Bearer <admin-token>"
```

</TabItem>
</Tabs>
