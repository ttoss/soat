---
description: "First-class action-class policies that classify each agent tool call — execute, require approval, or block — with non-LLM guard expressions and per-project overrides."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Guardrails

Guardrails classify every tool call an agent makes into an action class — execute autonomously, route to human approval, or block — using deterministic, non-LLM guard expressions.

## Overview

A guardrail is a **standalone, versioned resource** — separate from [IAM policies](./policies.md), which it deliberately does not touch. Where an IAM policy answers _"may this caller invoke this endpoint?"_ at request time, a guardrail answers a different question at a different layer: _"may this agent take **this specific action, with these arguments, in this context**, on its own — or must a human sign off?"_. A guardrail maps tool calls to **action classes** (A/B/C/D) and gates class-B autonomy behind guard expressions evaluated at the tool-execution boundary — after the model produces the call and before anything touches the outside world. There is no LLM in the evaluation path.

Guardrails are the platform's **single tool-call gating mechanism**, superseding the deprecated per-binding [`approval_policy`](./agents.md#approval-policy): a class-C action routes into the same [approvals queue](./approvals.md) with the same return-pending / continuation mechanics, guards read spend from [usage metering](./usage.md), and expressions use the shared [JSON Logic](https://jsonlogic.com) evaluator that [orchestrations](./orchestrations.md) already use. A guardrail [attaches](#attachment) to an **agent** (governing every tool the agent can call) or to a **tool** (governing that tool for every agent that uses it); when both apply, the stricter decision wins.

A guardrail is a **reusable template**: defined once, it can govern agents across many projects — a central team sets the fleet's autonomy posture in one place. A single project then adapts that posture locally with a [per-project override](#per-project-overrides), which can only make the guardrail **stricter** (never looser). That is what the override earns you: one canonical guardrail, per-tenant tightening, no forking.

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

### ProjectGuardrailOverride

| Field          | Type    | Description                                                     |
| -------------- | ------- | -------------------------------------------------------------- |
| `project_id`   | string  | The `proj_`-prefixed project the override applies to           |
| `guardrail_id` | string  | The guardrail being overridden                                 |
| `document`     | object  | Same shape as the guardrail's `document`; evaluated alongside the template — **stricter result wins** (see [Per-project Overrides](#per-project-overrides)) |
| `version`      | integer | Incremented on every override write                            |

## Key Concepts

### Attachment

A guardrail attaches through a `guardrail_id` field on either resource — it is **not** attached the way IAM policies attach to users and API keys:

- **On an agent** — governs **every** tool call the agent makes, across all its bindings. This is the fleet-posture form: one document classifies the agent's entire tool surface, and `default_class` covers any tool nobody thought about.
- **On a tool** — governs that tool **wherever it is used**, by any agent. A dangerous tool carries its own gate; binding it to a new agent can never silently escape classification.

When both an agent-level and a tool-level guardrail apply to the same call, **both evaluate and the stricter decision wins** (`blocked` > `route_to_approval` > guarded execute > execute) — composition can only tighten, the same invariant as [per-project overrides](#per-project-overrides). One `guardrail_evaluation` record is written per guardrail evaluated.

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

`class` is either a literal — a tool-attached guardrail that always requires sign-off is just `{ "class": "C" }` — or a **single JSON Logic expression** that returns the class. The expression evaluates over the same three namespaces as guards (`args.*` / `context.*` / `soat.*`), so classification can depend on which tool is called (`soat.tool.name`), the arguments, or runtime context. There is no rule list and no matching order: one expression, one result.

```json
{
  "default_class": "C",
  "class": {
    "if": [
      { "==": [{ "var": "soat.tool.name" }, "search-docs"] }, "A",
      { "and": [
        { "==": [{ "var": "soat.tool.name" }, "update-budget"] },
        { "<": [{ "var": "args.amount" }, 500] }
      ] }, "B",
      { "==": [{ "var": "soat.tool.name" }, "delete-account"] }, "D",
      "C"
    ]
  },
  "guard": {
    "and": [
      { "<=": [{ "var": "args.amount" }, { "var": "context.max_daily_budget" }] },
      { "<": [{ "var": "soat.usage.cost_usd_24h" }, { "var": "context.cost_ceiling" }] }
    ]
  }
}
```

The same tool can classify **B** below a threshold and **C** above it — that is just an `if` branch over `args`. Anything the expression doesn't account for falls through to `default_class` (see [Action Classes](#action-classes)).

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

The context-tool call is bounded — a per-call timeout and a short per-`(project, guardrail)` TTL cache — and it is invoked by the platform's dispatch path only: the model never sees it, calls it, or influences its output.

The `soat.*` catalog (windows are baked into the key name — a fixed suffix set `_1h` / `_24h` / `_7d` / `_30d`, each rolling and ending at evaluation time):

| Key                                                        | Type    | Source                                                  |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `soat.action` / `soat.tool.id` / `soat.tool.name`          | string  | The call being classified                               |
| `soat.agent.id` / `soat.project.id`                        | string  | Evaluation identity                                     |
| `soat.run.node_attempt` / `soat.run.tool_calls`            | integer | Current [orchestration run](./orchestrations.md) state  |
| `soat.activity.actions_1h` / `soat.activity.actions_24h`   | integer | [Activity feed](./approvals.md) (per project)           |
| `soat.usage.cost_usd_1h` / `_24h` / `_7d` / `_30d`         | number  | [Usage metering](./usage.md) (per project)              |
| `soat.usage.tokens_24h` / `soat.usage.tokens_30d`          | integer | [Usage metering](./usage.md) (per project)              |

**Fail-closed at both ends.** At write time, a document referencing a `var` outside the three namespaces — or a `soat.*` key outside the catalog — is rejected with `400`, never silently `null` at runtime. At evaluation time, an expression referencing a `context.*` key absent from the effective context, a context-tool failure or timeout, or a `soat.*` provider that cannot resolve all fail closed: in `class`, the result resolves to `default_class`; in `guard`, it counts as a **failed guard** and tripwire semantics apply. Forgetting to supply context tightens the posture; it never loosens it.

### Tripwires and `escalate`

A failing class-B guard is a **tripwire**: by default it aborts the action and files an exception rather than silently downgrading — a runaway loop hits a hard, non-LLM stop. A document with `escalate: true` opts into the softer behavior: a failing guard routes the call to the [approvals queue](./approvals.md) for a human decision instead of aborting.

### Per-project Overrides

A `ProjectGuardrailOverride` lets one project run a tighter risk posture than the fleet. Its `document` has the same shape as the guardrail's and evaluates **alongside** the template: the effective class is the **stricter** of the two results (`D` > `C` > `B` > `A`), and when both carry a `guard`, **both must pass** — the same composition rule as [agent + tool attachment](#attachment). Tighten-only is therefore enforced by construction, not by static analysis: an override can downgrade `B → C` for its project, but can never upgrade `C → B` or weaken a guard, and other projects on the template are unchanged.

Because `A` is the identity under stricter-wins, an override's `class` expression should return `"A"` for calls it doesn't care about. Its `default_class` follows the same fail-closed rule as the template's — an override whose expression returns an unknown value tightens to `C`.

### Versioning

Every write to a guardrail's `document` increments `version` and archives the prior document as a `GuardrailVersion`. Approval items, activity entries, and exceptions record the version that governed them, so the audit chain survives edits. Fetch the exact governing document with [`GET /api/v1/guardrails/{guardrail_id}/versions/{version}`](#fetch-an-archived-version).

### Evaluation Audit Record

Every evaluation — execute, route-to-approval, block, or tripwire — writes a `guardrail_evaluation` activity entry (and stamps the generation/run record) capturing the governing `guardrail_version`, the classification, the guard outcome, and provenance:

```json
{
  "kind": "guardrail_evaluation",
  "guardrail_id": "guard_V1StGXR8Z5jdHi6B",
  "guardrail_version": 3,
  "override_version": 1,
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
- `override_version` is `null` when no project override was layered in.
- `context_source` records where the effective context came from: `caller` \| `tool` \| `merged` \| `none`.
- `guard_result` is the guard expression's boolean outcome; `null` when the document has no guard or the call did not classify as `B`.
- `context_snapshot` is a flat map of **only the vars the evaluation actually referenced** — every `var` in the `class` and `guard` expressions, keyed by its fully-qualified path (`args.*` / `context.*` / `soat.*`) and frozen at its evaluation-time value. The full `guardrail_context` may carry many more keys; those are not recorded. This is the only way to answer "why did this pass?" after the application's context (or platform usage counters) have moved on, while keeping the record small and free of unreferenced — possibly sensitive — context.

## Examples

### Create a guardrail

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-guardrail \
  --name "Budget Guardrails" \
  --document '{
    "default_class": "C",
    "class": { "if": [
      { "and": [
        { "==": [{ "var": "soat.tool.name" }, "update-budget"] },
        { "<": [{ "var": "args.amount" }, 500] }
      ] }, "B",
      { "==": [{ "var": "soat.tool.name" }, "delete-account"] }, "D",
      "C"
    ] },
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
    name: 'Budget Guardrails',
    document: {
      default_class: 'C',
      class: {
        if: [
          {
            and: [
              { '==': [{ var: 'soat.tool.name' }, 'update-budget'] },
              { '<': [{ var: 'args.amount' }, 500] },
            ],
          },
          'B',
          { '==': [{ var: 'soat.tool.name' }, 'delete-account'] },
          'D',
          'C',
        ],
      },
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
    "name": "Budget Guardrails",
    "document": {
      "default_class": "C",
      "class": { "if": [
        { "and": [
          { "==": [{ "var": "soat.tool.name" }, "update-budget"] },
          { "<": [{ "var": "args.amount" }, 500] }
        ] }, "B",
        { "==": [{ "var": "soat.tool.name" }, "delete-account"] }, "D",
        "C"
      ] },
      "guard": { "<": [{ "var": "soat.usage.cost_usd_24h" }, 1000] }
    }
  }'
```

</TabItem>
</Tabs>

### Attach a guardrail

Attach to an agent to govern its whole tool surface, or to a tool (`soat update-tool --tool-id tool_01 --guardrail-id …`) to govern that tool for every agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent \
  --agent-id agent_01 \
  --guardrail-id guard_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.agents.updateAgent({
  path: { agent_id: 'agent_01' },
  body: { guardrail_id: 'guard_V1StGXR8Z5jdHi6B' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/agents/agent_01 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"guardrail_id": "guard_V1StGXR8Z5jdHi6B"}'
```

</TabItem>
</Tabs>

### Tighten a guardrail for one project (override)

This override downgrades `update-budget` to class **C** for `proj_ABC` only; it returns `"A"` (the identity under stricter-wins) for every other call, leaving the template's classification in effect.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat set-project-guardrail-override \
  --project-id proj_ABC \
  --guardrail-id guard_V1StGXR8Z5jdHi6B \
  --document '{ "class": { "if": [
    { "==": [{ "var": "soat.tool.name" }, "update-budget"] }, "C",
    "A"
  ] } }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.guardrails.setProjectGuardrailOverride({
  path: { project_id: 'proj_ABC', guardrail_id: 'guard_V1StGXR8Z5jdHi6B' },
  body: {
    document: {
      class: {
        if: [{ '==': [{ var: 'soat.tool.name' }, 'update-budget'] }, 'C', 'A'],
      },
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PUT https://api.example.com/api/v1/projects/proj_ABC/guardrail-overrides/guard_V1StGXR8Z5jdHi6B \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "document": { "class": { "if": [
    { "==": [{ "var": "soat.tool.name" }, "update-budget"] }, "C",
    "A"
  ] } } }'
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
