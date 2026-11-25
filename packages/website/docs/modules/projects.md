---
description: 'Multi-tenant namespaces in SOAT; every document, file, actor, and conversation belongs to a project.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Projects

Projects are multi-tenant namespaces; every resource ([document](./documents.md), [file](./files.md), [actor](./actors.md), [conversation](./conversations.md)) belongs to one. Ids are prefixed `proj_`.

## Overview

Access is policy-based, with no membership table: the [policies](./policies.md) attached to the account and their SRN patterns decide. Walkthrough: [Chat with an LLM - Step 2 (Create a project)](/docs/tutorials/chat-with-llm#step-2--create-a-project).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 2 (Create a project)](/docs/tutorials/chat-with-llm#step-2--create-a-project)
- [Permissions in Practice - Step 3 (Create the Analytics project)](/docs/tutorials/permissions#step-3--create-the-analytics-project)
- [Deploy a Multi-Agent App with Agent Formation - Step 2 (Create a project)](/docs/tutorials/formations#step-2--create-a-project)
- [Data Retention and Zero-Retention - Step 7 (Automate it with a retention window)](/docs/tutorials/data-retention-and-zero-retention#step-7--automate-it-with-a-retention-window)

## Data Model

| Field                            | Type            | Description                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | string          | Public identifier prefixed with `proj_`                                                                                                                                                                                                                                                                                                                                                                  |
| `name`                           | string          | Human-readable project name                                                                                                                                                                                                                                                                                                                                                                              |
| `guardrail_ids`                  | array           | Guardrails attached at the project scope — the baseline governing every tool call by every agent in the project. See [Guardrails — Attachment](./guardrails.md#attachment)                                                                                                                                                                                                                               |
| `agent_policy_ids`               | array \| null   | [Policies](./policies.md) capping every turn of every agent the project owns, its stored `knowledge_config` retrieval included. `null` (default) or `[]` adds no cap. See [Project agent cap](#project-agent-cap).                                                                                                                                                                                       |
| `content_bound_tag_keys`         | array           | Tag keys that state a judgment about what an agent can read; removed by a write that changes that text. `[]` (default) names none. See [Content-bound tag keys](#content-bound-tag-keys)                                                                                                                                                                                                                 |
| `default_model_route_id`         | string \| null  | [Model route](./model-routes.md#project-default-route) inherited by consumers in this project that bind neither `model_route_id` nor `ai_provider_id`. `null` (default) means no default, so every consumer must bind explicitly. Settable/clearable via `update-project`.                                                                                                                               |
| `max_concurrent_runs`            | integer \| null | Maximum [orchestration runs](./orchestrations.md#concurrency-limits) of this project driven at once. `null` (default) means unlimited; otherwise an integer ≥ 1. Settable/clearable via `update-project`.                                                                                                                                                                                                |
| `max_chain_generations`          | integer \| null | Generations one [continuation chain](./chains.md#bounding-a-chain) in this project may hold before the platform stops resuming it. `null` (default) means no project ceiling, leaving the deployment-wide one; otherwise an integer ≥ 1. The effective budget is the smallest of the deployment's ceiling, this one, and the agent's own `maxChainGenerations`. Settable/clearable via `update-project`. |
| `max_orchestration_run_depth`    | integer \| null | `loop` / `sub_orchestration` [nesting levels](./orchestrations.md#nesting-depth) a run tree in this project may reach before the engine refuses to start the next child. `null` (default) means no project bound, leaving the deployment-wide one; otherwise an integer ≥ 1. The effective bound is the smaller of the two. Settable/clearable via `update-project`.                                     |
| `min_trigger_interval_seconds`   | integer \| null | Seconds a [schedule trigger](./triggers.md#schedules-and-misfire-coalescing)'s `cron` must leave between its two closest firings. `null` (default) means no floor; otherwise an integer ≥ 1. Settable/clearable via `update-project` by an admin only (`403` otherwise).                                                                                                                                 |
| `audit_reads_enabled`            | boolean         | Opts the project into [read auditing](./audit-log.md#read-auditing): when `true`, `GET` requests naming this project are recorded in the audit log alongside mutations. `false` by default. Settable via `update-project`.                                                                                                                                                                               |
| `require_priced_model`           | boolean         | Refuses a model call (agent generation, chat completion, memory extraction, `llm_judge` scorer) whose model carries no [price-book](./usage.md#pricing) row with `409 MODEL_NOT_PRICED`. `false` by default. Settable via `update-project`. See [Priced models](#priced-models).                                                                                                                                                                                             |
| `default_conversation_retrieval` | string          | What a [conversation](./conversations.md) that names no `retrieval` of its own does: `embed` or `none` (default).                                                                                                                                                                                                                                                                                        |
| `trace_content_retention_days`   | integer \| null | Days of [trace/generation content retention](./traces.md#retention-policy) before the daily sweep purges it. `null` (default) disables retention; otherwise an integer ≥ 1. Settable/clearable via `update-project`.                                                                                                                                                                                     |
| `trace_content_mode`             | string          | `full` (default) or `none`. `none` is [zero-retention](./traces.md#zero-retention-mode): trace and generation content is never written for any agent in the project. Settable via `update-project`.                                                                                                                                                                                                      |
| `paused_at`                      | string \| null  | When the project was [paused](#pausing-a-project); `null` while it runs.                                                                                                                                                                                                                                                                                                                                 |
| `pause_reason`                   | string \| null  | The reason the pause named, up to 256 characters; `null` while the project runs or when the pause named none.                                                                                                                                                                                                                                                                                            |
| `created_at`                     | string          | ISO 8601 creation timestamp                                                                                                                                                                                                                                                                                                                                                                              |
| `updated_at`                     | string          | ISO 8601 last-updated timestamp                                                                                                                                                                                                                                                                                                                                                                          |

## Key Concepts

### Project Access via Policies

Access is granted by attaching a [Policy](./policies.md) to the user (or API key) with an `Allow` statement covering the project's SRN pattern:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["projects:GetProject", "files:ListFiles", "files:GetFile"],
      "resource": ["srn:proj_ABC:*:*"]
    }
  ]
}
```

Walkthrough: [Permissions in Practice - Step 3 (Create the Analytics project)](/docs/tutorials/permissions#step-3--create-the-analytics-project).

All projects: a wildcard project segment:

```json
{ "resource": ["srn:*:*:*"] }
```

### Visibility Rules

- **An unrestricted admin** (a login, or an admin's key with no `project_id` and no `policy_ids`) sees all projects. An admin's key pinned to a project or narrowed by `policy_ids` sees only what that pin and those policies allow.
- **API key callers** scoped to a project see only that project.
- **Regular users** see only the projects covered by the SRN patterns in their attached policies.

Authorization is policy-only; a project-scoped grant is honored by every project endpoint, including [`GET /projects/{id}`](/docs/api/projects/get-project). See [IAM](./iam.md).

Creating and deleting a project are admin-only. [`PATCH /projects/{id}`](/docs/api/projects/update-project) is `projects:UpdateProject`: a policy granting it on `srn:<project-id>:*:*` lets a non-admin user, or a key it mints for that project, change the project's settings. Detaching a guardrail additionally needs `guardrails:DetachGuardrail`.

### Project selection

A project-bound credential (an API key with a `project_id`, or an IAM token minted from one) names its project, so no route needs `project_id` from it: a list reads that project, a write lands in it, and a per-project route (the [activity](./activity.md), [audit-log](./audit-log.md) and [documents](./documents.md) exports, the [usage](./usage.md) aggregate) reads it with no selector. A `project_id` naming another project is refused. A credential bound to no project names the project with `project_id`; a per-project route without one is `400 VALIDATION_FAILED`.

### Project agent cap

`agent_policy_ids` holds a rule every agent in the project obeys — "agents read only screened content", "no agent writes outside `/reports/`" — in one place, so an agent created, restored or released without it is still bound:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id proj_… --agent_policy_ids '["pol_…"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.projects.updateProject({
  path: { project_id: 'proj_…' },
  body: { agent_policy_ids: ['pol_…'] },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/projects/proj_… \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "agent_policy_ids": ["pol_…"] }'
```

</TabItem>
</Tabs>

- **One more cap.** Every turn of an agent the project owns must also satisfy these policies, under both `run_as` modes and on every path the agent's own [`policy_ids`](./agents.md#execution-identity) cap: `builtin` actions, `http`, `mcp` and `pipeline` tool calls, approved actions, pipeline steps, resumption, `On-Behalf-Of` callbacks, `write_memory`, and what the caller names (a `document` or `tool_output` message, a `knowledge_config` override).
- **Stored knowledge too.** The agent's stored [`knowledge_config`](./agents.md#knowledge-config) retrieval reads under the turn's authority, so the cap bounds it beside the agent's own `policy_ids`: whoever governs the project sets it, not the agent's author.
- **Shared agents** are bounded by their owner project's cap, wherever they run.
- **Read live.** Each turn, approval and continuation reads the cap as it stands, and durable work an agent starts under `run_as: agent` stores it as a cap read at every later check, so tightening it reaches work already pending.
- **Refusals name the project**: `meta.denied_by` is `{ "type": "project", "id": "proj_…" }`, on a tool server's [`On-Behalf-Of`](./tools.md#writing-on-behalf-of-a-tool-call) callback too.
- **Writes** need `projects:UpdateProject`, and follow the agent `policy_ids` rules: the caller must hold every grant the policies carry (`403 POLICY_GRANT_NOT_HELD`), an empty entry is `400 VALIDATION_FAILED`, an unknown id is `400 POLICY_NOT_FOUND`, a policy named here cannot be deleted (`409 POLICY_HAS_DEPENDENTS`), and one that no longer resolves allows nothing.

### Default Model Route

`default_model_route_id` names the [model route](./model-routes.md) inherited by every consumer binding neither `model_route_id` nor `ai_provider_id`, giving agents, chats, and memory completions failover without editing each:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id proj_… --default_model_route_id route_…
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.projects.updateProject({
  path: { project_id: 'proj_…' },
  body: { default_model_route_id: 'route_…' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/projects/proj_… \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "default_model_route_id": "route_…" }'
```

</TabItem>
</Tabs>

The route must belong to the project. An explicit binding always wins. Repointing is free; **clearing** returns `409 PROJECT_DEFAULT_ROUTE_INHERITED` while any consumer inherits it, and deleting the route itself returns `409 MODEL_ROUTE_HAS_DEPENDENTS`. Governed by `projects:UpdateProject`.

### Priced models

`require_priced_model` refuses a model call whose model no price row covers,
before the provider is called: an agent generation (fresh or resumed), a
[chat completion](./chats.md#priced-models), a memory extraction and an
`llm_judge` scorer alike, because every one builds its model through the same
check. On the project it holds every provider;
on an [AI provider](./ai-providers.md#requiring-a-priced-model) it holds that
provider alone, and a candidate is checked when either flag holds it:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id proj_ABC --require_priced_model true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.projects.updateProject({
  path: { project_id: 'proj_ABC' },
  body: { require_priced_model: true },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/projects/proj_ABC \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "require_priced_model": true }'
```

</TabItem>
</Tabs>

The refusal is `409 MODEL_NOT_PRICED`, and `error.meta.unpriced_rows` names each
`(provider, model, component)` to price. It is raised before the generation
record exists, so a refused turn is neither recorded nor metered.

- Both billable token components are checked, `input_tokens` and
  `output_tokens`: a model priced for one and not the other meters a cost that
  understates itself. The cache components fall back to the `input_tokens` rate
  and need no row of their own.
- An agent bound to a [model route](./model-routes.md) is held to **every**
  target, not just the first: a failover bills whichever target answers.
- Prices resolve through the usual tiers, so a per-provider override or a
  project rate satisfies the gate — see [Usage — Pricing](./usage.md#pricing).
- The check reads the configured model name. A provider that answers under a
  more specific id meters under that id; the
  [`quota_unpriced` exception](./quotas.md#unpriced-usage) names it.
- Every agent turn is checked, whatever starts it: an agent, session or
  conversation generation, or an agent a trigger or orchestration runs. A
  [chat completion](./chats.md) is not checked.
- [Embeddings](./embeddings.md#pricing-embeddings) are not gated: their rate is
  deployment configuration, outside every price-book tier.

`false` (the default) runs the model and meters it at `cost_usd: null`. A
`cost_usd` [quota](./quotas.md#unpriced-usage) answers the same gap from the
other side: it reads a window the meter already wrote, so it refuses spend that
has already happened, where this refuses spend before it starts.

### Pausing a project

[`POST /api/v1/projects/{project_id}/pause`](/docs/api/projects/pause-project) is a kill switch: one call stops everything the project runs. It is fireable by a person or by an automation — it is an IAM action (`projects:PauseProject`), so a project key granted it can pause its own project on an anomaly.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat pause-project --project-id proj_ABC --reason "spend anomaly"
soat resume-project --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await soat.projects.pauseProject({
  path: { project_id: 'proj_ABC' },
  body: { reason: 'spend anomaly' },
});
await soat.projects.resumeProject({ path: { project_id: 'proj_ABC' } });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/projects/proj_ABC/pause \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"reason": "spend anomaly"}'
curl -X POST https://api.example.com/api/v1/projects/proj_ABC/resume \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

While `paused_at` is set:

| What                                                                                                        | Under the pause                                                                                                                                        | On resume                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Agent, session and conversation generations, tool-output continuations, chat completions, direct tool calls | `409 PROJECT_PAUSED`                                                                                                                                   | Accepted again                                                            |
| Orchestration run and eval run starts, manual and webhook trigger fires                                     | `409 PROJECT_PAUSED`, no run or firing written                                                                                                         | Accepted again                                                            |
| Event triggers                                                                                              | A `failed` firing with code `PROJECT_PAUSED`                                                                                                           | Fire again                                                                |
| Schedule triggers                                                                                           | Not fired                                                                                                                                              | Fire from their next occurrence after now; a missed one is not fired late |
| Live [orchestration runs](./orchestrations.md)                                                              | [Paused](./orchestrations.md): parked at the next checkpoint with `required_action.type: paused` and the project's `pause_reason`                      | Resumed in the background                                                 |
| Open [tasks](./workflows.md)                                                                                | Automation paused: transitions work, state dispatches are suppressed                                                                                   | Suppressed dispatches run, as the caller who resumed                      |
| Queued [eval](./evaluations.md) items                                                                       | Not claimed; the run stays `running`                                                                                                                   | Continue from where they stopped                                          |
| [Playbook cases](./playbooks.md)                                                                            | Node runs, exports and a case's own resume are `409 PROJECT_PAUSED`; queued executions are not started, and the case reads `automation_status: paused` | Queued executions start                                                   |

A generation, node or eval item already in flight finishes. Reads and writes keep working, so the project can be inspected and fixed while paused — including writes that embed content, such as document ingestion and memory writes, which are not starts. `loop` / `sub_orchestration` children started under the pause are born paused.

Pausing is idempotent and keeps the first reason. [`POST /api/v1/projects/{project_id}/resume`](/docs/api/projects/resume-project) (`projects:ResumeProject`) answers `409 PROJECT_NOT_PAUSED` on a running project, and is not offered to agents as a `builtin` action: deciding to spend again is left to a person or an explicit credential.

The resume hands back only what the pause held. A run or task an operator paused before the project was paused keeps its own pause; resuming one run or task on its own while the project is paused is `409 PROJECT_PAUSED`.

Both transitions emit a [webhook event](./webhooks.md): `projects.paused` and `projects.resumed`, each carrying the project as its `data`.

### Content-bound tag keys

`content_bound_tag_keys` names tag keys that state a judgment about what an agent can read, such as a screening verdict (`screened: clean`). The judgment must not outlive the text it judged, so a write that changes that text removes the keys from the resource's tags:

| Resource                   | Writes that remove the keys                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Document](./documents.md) | A change to the content, `title`, `path` or `metadata`, moving or renaming its backing [file](./files.md) included; a re-ingest; a version restore that changes them, reviving a withdrawn document included. A restore brings back the archived tags but never an archived value of these keys: over the same text it keeps the current one |
| [Memory](./memories.md)    | A change to `content` or `metadata`. A superseding memory does not inherit them                                                                                                                                                                                                                                                              |

- A write that sets a key itself keeps it.
- Tag-only writes, and writes that re-send the stored value, keep them.
- Removing a key from the list does not restore tags already removed.
- Each key is a non-empty tag key outside the reserved `system.` prefix; `null` or `[]` names none. Anything else is `400 VALIDATION_FAILED`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id proj_V1StGXR8Z5jdHi6B --content-bound-tag-keys screened
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.projects.updateProject({
  path: { project_id: 'proj_V1StGXR8Z5jdHi6B' },
  body: { content_bound_tag_keys: ['screened'] },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/projects/proj_V1StGXR8Z5jdHi6B \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "content_bound_tag_keys": ["screened"] }'
```

</TabItem>
</Tabs>

### Deletion

Deleting a project with any dependent resource returns `409 Conflict`, code `PROJECT_HAS_DEPENDENTS`. Every project-scoped resource counts, including those accumulated while running:

- agents, AI providers, [model routes](./model-routes.md), tools, [ingestion rules](./ingestion-rules.md)
- actors, chats, conversations, sessions, [generations](./generations.md), [traces](./traces.md)
- [datasets and evals](./evaluations.md), [workflows and tasks](./workflows.md), [triggers](./triggers.md), [orchestrations](./orchestrations.md) and their runs
- [formations](./formations.md), [memories](./memories.md), [secrets](./secrets.md), [files](./files.md), [guardrails](./guardrails.md), [quotas](./quotas.md)
- priced [usage](./usage.md) history, and the [activity](./activity.md), [approval](./approvals.md), [exception](./exceptions.md) and guardrail-evaluation records of past runs

`?force=true` deletes all dependents in one transaction, including billing/usage history and the stored bytes of [files](./files.md).

The [audit log](./audit-log.md) is the exception: entries outlive the project with `project_id` cleared.

A deleted formation and a usage event with no `cost_usd` (or a zero one) are not dependents: a delete without `force` removes them with the project.

### Common Errors

| Status | Body                                                         | Cause                                                                                                                                                                                                                                                                                                                                   | What to do                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403`  | `FORBIDDEN`                                                  | Caller isn't the `admin` role — creating and deleting a project are admin-only. Creating also refuses an admin credential bound to a project or narrowed by policies; deleting refuses one whose policies or consent do not allow the action. Updating needs `projects:UpdateProject` on the project, from the `admin` role or a policy | Authenticate as the admin user, use an admin key with no `project_id` and no `policy_ids`, or, to update, attach a policy granting `projects:UpdateProject` on `srn:<project-id>:*:*`               |
| `403`  | `FORBIDDEN`                                                  | [`GET /projects/{id}`](/docs/api/projects/get-project) (or a nested resource route) with a policy/API key that doesn't cover this project's SRN — e.g. a project key created for a **different** project                                                                                                                                | Check the caller's attached policies cover `srn:<this-project-id>:*:*`, or use a key scoped to this project — see [Project Access via Policies](#project-access-via-policies)                       |
| `404`  | —                                                            | The project ID doesn't exist, or the caller can't see it because no policy grants access to it (existence isn't leaked)                                                                                                                                                                                                                 | Verify the ID; if it should exist, confirm a policy grants visibility — see [Visibility Rules](#visibility-rules)                                                                                   |
| `409`  | `{ "error": { "code": "PROJECT_HAS_DEPENDENTS" } }`          | Deleting a project that still has dependent resources                                                                                                                                                                                                                                                                                   | Pass `?force=true`, or delete the dependent resources first — see [Deletion](#deletion)                                                                                                             |
| `409`  | `{ "error": { "code": "PROJECT_PAUSED" } }`                  | Starting work — a generation, run, eval run, tool call or trigger fire — or resuming a run or task in a paused project                                                                                                                                                                                                                  | Resume the project once whatever paused it is resolved; `error.meta.pause_reason` says why — see [Pausing a project](#pausing-a-project)                                                            |
| `409`  | `{ "error": { "code": "PROJECT_NOT_PAUSED" } }`              | Resuming a project that is not paused                                                                                                                                                                                                                                                                                                   | Nothing to do; `paused_at` is `null`                                                                                                                                                                |
| `409`  | `{ "error": { "code": "MODEL_NOT_PRICED" } }`                | A model call whose project or provider has `require_priced_model` and whose model carries no price row                                                                                                                                                                                                                                      | Price the `(provider, model, component)` rows in `error.meta.unpriced_rows`, or set `require_priced_model` to `false` — see [Priced models](#priced-models)                                         |
| `403`  | `{ "error": { "code": "POLICY_GRANT_NOT_HELD" } }`           | Setting `agent_policy_ids` to a policy granting what the caller does not hold                                                                                                                                                                                                                                                           | Use a caller holding every grant, or narrower policies — see [Project agent cap](#project-agent-cap)                                                                                                |
| `400`  | `{ "error": { "code": "POLICY_NOT_FOUND" } }`                | `agent_policy_ids` names a policy that does not exist                                                                                                                                                                                                                                                                                   | Check the policy ids                                                                                                                                                                                |
| `409`  | `{ "error": { "code": "PROJECT_DEFAULT_ROUTE_INHERITED" } }` | Clearing `default_model_route_id` while consumers that bind nothing inherit it — they would be left with no resolvable model                                                                                                                                                                                                            | Bind those consumers explicitly (`meta.sample` names some), or repoint the default to another route, which is always allowed — see [Project default route](./model-routes.md#project-default-route) |

## Examples

### Create a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-project --name "My Project"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.projects.createProject({
  body: { name: 'My Project' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/projects \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project"}'
```

</TabItem>
</Tabs>

### Get a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-project --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.projects.getProject({
  path: { project_id: 'proj_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/projects/proj_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Delete a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat delete-project --project-id proj_ABC

# Force-delete a project along with all of its dependent resources
soat delete-project --project-id proj_ABC --force true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { error } = await soat.projects.deleteProject({
  path: { project_id: 'proj_ABC' },
  query: { force: true },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X DELETE "https://api.example.com/api/v1/projects/proj_ABC?force=true" \
  -H "Authorization: Bearer <admin-token>"
```

</TabItem>
</Tabs>
