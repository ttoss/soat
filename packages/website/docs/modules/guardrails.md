---
description: "First-class action-class policies that classify each agent tool call — execute, require approval, or block — with non-LLM guard expressions and per-project overrides."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Guardrails

Guardrails classify every tool call an agent makes into an action class — execute autonomously, route to human approval, or block — using deterministic, non-LLM guard expressions.

## Overview

A guardrail is a **standalone, versioned resource** — separate from [IAM policies](./policies.md), which it deliberately does not touch. Where an IAM policy answers _"may this caller invoke this endpoint?"_ at request time, a guardrail answers a different question at a different layer: _"may this agent take **this specific action, with these arguments, in this context**, on its own — or must a human sign off?"_. A guardrail maps tool calls to **action classes** (A/B/C/D) and gates class-B autonomy behind guard expressions evaluated at the tool-execution boundary — after the model produces the call and before anything touches the outside world. There is no LLM in the evaluation path.

Guardrails are the fleet-level form of the per-binding [`approval_policy`](./agents.md#approval-policy): a class-C action routes into the same [approvals queue](./approvals.md), guards read spend from [usage metering](./usage.md), and expressions use the shared [JSON Logic](https://jsonlogic.com) evaluator that [orchestrations](./orchestrations.md) already use. An agent opts in by referencing a guardrail via its `guardrail_id`.

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

| Field           | Type    | Description                                                                 |
| --------------- | ------- | --------------------------------------------------------------------------- |
| `default_class` | string  | Class applied when no rule matches. Defaults to `C` (fail-closed)           |
| `rules`         | array   | Ordered; **first match wins**. Each rule is `{ match, class, guards?, escalate? }` |

Each rule:

| Field      | Type    | Description                                                                                  |
| ---------- | ------- | -------------------------------------------------------------------------------------------- |
| `match`    | object  | `{ tool, where? }` — the tool (by name or id) and an optional JSON Logic predicate over `args` |
| `class`    | string  | `A` \| `B` \| `C` \| `D` (see [Action Classes](#action-classes))                             |
| `guards`   | array   | JSON Logic expressions; for class `B`, **all** must pass to execute autonomously             |
| `escalate` | boolean | When `true`, a failing guard routes to approval instead of tripping fail-closed              |

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
| `document`     | object  | A partial document layered over the template (**tighten-only**) |
| `version`      | integer | Incremented on every override write                            |

An agent references its guardrail through a `guardrail_id` field (project-gated, with a per-generate override) — a guardrail is **not** attached the way IAM policies attach to users and API keys.

## Key Concepts

### Action Classes

| Class | Meaning                | Behavior                                                                                     |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------- |
| **A** | Read-only / harmless   | Always execute; logged to the activity feed                                                  |
| **B** | Autonomous with guards | Execute **iff all guards pass**; a failing guard trips fail-closed (or routes to approval — see [Tripwires](#tripwires-and-escalate)) |
| **C** | Human sign-off         | Files an [`ApprovalItem`](./approvals.md) (`origin: tool_call`); executes only on approval    |
| **D** | Forbidden              | The tool is never attached; the classifier blocks it as defense-in-depth                     |

Unmatched actions take `default_class`, which itself defaults to **C** — anything nobody classified requires a human. Fail-closed is the invariant: a misconfigured or absent classification never grants autonomy.

### Match Predicates

`match.tool` names a tool by name or id. `match.where` is an optional JSON Logic predicate over `args` (the resolved call arguments), so the same tool can be class **B** below a threshold and class **C** above it. Rules are ordered and the first match wins.

```json
{
  "match": { "tool": "update-budget", "where": { "<": [{ "var": "args.amount" }, 500] } },
  "class": "B",
  "guards": [
    { "<=": [{ "var": "args.amount" }, { "var": "context.max_daily_budget" }] },
    { "<": [{ "var": "soat.usage.cost_usd_24h" }, { "var": "context.cost_ceiling" }] }
  ]
}
```

### Guards and Guardrail Context

Guards are JSON Logic expressions — the same evaluator [orchestration](./orchestrations.md) mappings use — with no `eval` and no LLM in the path. Every `var` resolves against exactly three namespaces:

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

**Fail-closed at both ends.** At write time, a document referencing a `var` outside the three namespaces — or a `soat.*` key outside the catalog — is rejected with `400`, never silently `null` at runtime. At evaluation time, a guard referencing a `context.*` key absent from the effective context, a context-tool failure or timeout, or a `soat.*` provider that cannot resolve all count as a **failed guard** and tripwire semantics apply. Forgetting to supply context tightens the posture; it never loosens it.

### Tripwires and `escalate`

A failing class-B guard is a **tripwire**: by default it aborts the action and files an exception rather than silently downgrading — a runaway loop hits a hard, non-LLM stop. A rule with `escalate: true` opts into the softer behavior: a failing guard routes the call to the [approvals queue](./approvals.md) for a human decision instead of aborting.

### Per-project Overrides

A `ProjectGuardrailOverride` layers over the template guardrail at evaluation time so one project can run a tighter risk posture than the fleet. Overrides can **tighten only** — downgrade `B → C`, add guards, or lower `default_class` — never upgrade `C → B` or remove guards. Downgrading `B → C` for one project leaves every other project on the template unchanged.

### Versioning

Every write to a guardrail's `document` increments `version` and archives the prior document as a `GuardrailVersion`. Approval items, activity entries, and exceptions record the version that governed them, so the audit chain survives edits. Fetch the exact governing document with [`GET /api/v1/guardrails/{guardrail_id}/versions/{version}`](#fetch-an-archived-version).

### Evaluation Audit Record

Every evaluation — execute, route-to-approval, block, or tripwire — writes a `guardrail_evaluation` activity entry (and stamps the generation/run record) capturing the governing `guardrail_version`, matched `rule_index`, per-guard results, and provenance:

```json
{
  "kind": "guardrail_evaluation",
  "guardrail_id": "guard_V1StGXR8Z5jdHi6B",
  "guardrail_version": 3,
  "override_version": 1,
  "tool": "update-budget",
  "rule_index": 0,
  "class": "B",
  "decision": "execute",
  "guard_results": [{ "index": 0, "result": true }, { "index": 1, "result": true }],
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
- `rule_index` is the first matching rule's index; `-1` means no rule matched and `default_class` applied.
- `override_version` is `null` when no project override was layered in.
- `context_source` records where the effective context came from: `caller` \| `tool` \| `merged` \| `none`.
- `context_snapshot` is a flat map of **only the vars the evaluation actually referenced** — every `var` in the matched rule's `match.where` and `guards`, keyed by its fully-qualified path (`args.*` / `context.*` / `soat.*`) and frozen at its evaluation-time value. The full `guardrail_context` may carry many more keys; those are not recorded. This is the only way to answer "why did this pass?" after the application's context (or platform usage counters) have moved on, while keeping the record small and free of unreferenced — possibly sensitive — context.

## Examples

### Create a guardrail

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-guardrail \
  --name "Budget Guardrails" \
  --document '{
    "default_class": "C",
    "rules": [
      { "match": { "tool": "update-budget", "where": { "<": [{ "var": "args.amount" }, 500] } },
        "class": "B",
        "guards": [ { "<": [{ "var": "soat.usage.cost_usd_24h" }, 1000] } ] },
      { "match": { "tool": "update-budget" }, "class": "C" },
      { "match": { "tool": "delete-account" }, "class": "D" }
    ]
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
      rules: [
        {
          match: { tool: 'update-budget', where: { '<': [{ var: 'args.amount' }, 500] } },
          class: 'B',
          guards: [{ '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] }],
        },
        { match: { tool: 'update-budget' }, class: 'C' },
        { match: { tool: 'delete-account' }, class: 'D' },
      ],
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
      "rules": [
        { "match": { "tool": "update-budget", "where": { "<": [{ "var": "args.amount" }, 500] } },
          "class": "B", "guards": [ { "<": [{ "var": "soat.usage.cost_usd_24h" }, 1000] } ] },
        { "match": { "tool": "update-budget" }, "class": "C" },
        { "match": { "tool": "delete-account" }, "class": "D" }
      ]
    }
  }'
```

</TabItem>
</Tabs>

### Tighten a guardrail for one project (override)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat set-project-guardrail-override \
  --project-id proj_ABC \
  --guardrail-id guard_V1StGXR8Z5jdHi6B \
  --document '{ "rules": [ { "match": { "tool": "update-budget" }, "class": "C" } ] }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.guardrails.setProjectGuardrailOverride({
  path: { project_id: 'proj_ABC', guardrail_id: 'guard_V1StGXR8Z5jdHi6B' },
  body: {
    document: {
      rules: [{ match: { tool: 'update-budget' }, class: 'C' }],
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
  -d '{ "document": { "rules": [ { "match": { "tool": "update-budget" }, "class": "C" } ] } }'
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
