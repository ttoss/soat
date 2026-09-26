---
description: "Multi-tenant namespaces in SOAT; every document, file, actor, and conversation belongs to a project."
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

| Field        | Type   | Description                             |
| ------------ | ------ | --------------------------------------- |
| `id`         | string | Public identifier prefixed with `proj_` |
| `name`       | string | Human-readable project name             |
| `guardrail_ids` | array | Guardrails attached at the project scope — the baseline governing every tool call by every agent in the project. See [Guardrails — Attachment](./guardrails.md#attachment) |
| `default_model_route_id` | string \| null | [Model route](./model-routes.md#project-default-route) inherited by consumers in this project that bind neither `model_route_id` nor `ai_provider_id`. `null` (default) means no default, so every consumer must bind explicitly. Settable/clearable via `update-project`. |
| `max_concurrent_runs` | integer \| null | Maximum [orchestration runs](./orchestrations.md#concurrency-limits) of this project driven at once. `null` (default) means unlimited; otherwise an integer ≥ 1. Settable/clearable via `update-project`. |
| `max_chain_generations` | integer \| null | Generations one [continuation chain](./chains.md#bounding-a-chain) in this project may hold before the platform stops resuming it. `null` (default) means no project ceiling, leaving the deployment-wide one; otherwise an integer ≥ 1. The effective budget is the smallest of the deployment's ceiling, this one, and the agent's own `maxChainGenerations`. Settable/clearable via `update-project`. |
| `max_orchestration_run_depth` | integer \| null | `loop` / `sub_orchestration` [nesting levels](./orchestrations.md#nesting-depth) a run tree in this project may reach before the engine refuses to start the next child. `null` (default) means no project bound, leaving the deployment-wide one; otherwise an integer ≥ 1. The effective bound is the smaller of the two. Settable/clearable via `update-project`. |
| `audit_reads_enabled` | boolean | Opts the project into [read auditing](./audit-log.md#read-auditing): when `true`, `GET` requests naming this project are recorded in the audit log alongside mutations. `false` by default. Settable via `update-project`. |
| `require_priced_model` | boolean | Refuses a generation whose model carries no [price-book](./usage.md#pricing) row with `409 MODEL_NOT_PRICED`. `false` by default. Settable via `update-project`. See [Priced models](#priced-models). |
| `default_conversation_retrieval` | string | What a [conversation](./conversations.md) that names no `retrieval` of its own does: `embed` or `none` (default). |
| `trace_content_retention_days` | integer \| null | Days of [trace/generation content retention](./traces.md#retention-policy) before the daily sweep purges it. `null` (default) disables retention; otherwise an integer ≥ 1. Settable/clearable via `update-project`. |
| `trace_content_mode` | string | `full` (default) or `none`. `none` is [zero-retention](./traces.md#zero-retention-mode): trace and generation content is never written for any agent in the project. Settable via `update-project`. |
| `paused_at` | string \| null | When the project was [paused](#pausing-a-project); `null` while it runs. |
| `pause_reason` | string \| null | The reason the pause named, up to 256 characters; `null` while the project runs or when the pause named none. |
| `created_at` | string | ISO 8601 creation timestamp             |
| `updated_at` | string | ISO 8601 last-updated timestamp         |

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

- **Admin users** see all projects.
- **API key callers** scoped to a project see only that project.
- **Regular users** see only the projects covered by the SRN patterns in their attached policies.

Authorization is policy-only; a project-scoped grant is honored by every project endpoint, including [`GET /projects/{id}`](/docs/api/projects/get-project). See [IAM](./iam.md).

### Default Model Route

`default_model_route_id` names the [model route](./model-routes.md) inherited by every consumer binding neither `model_route_id` nor `ai_provider_id`, giving agents, chats, and memory completions failover without editing each:

```bash
soat update-project --project-id proj_… --default_model_route_id route_…
```

The route must belong to the project. An explicit binding always wins. Repointing is free; **clearing** returns `409 PROJECT_DEFAULT_ROUTE_INHERITED` while any consumer inherits it, and deleting the route itself returns `409 MODEL_ROUTE_HAS_DEPENDENTS`. Governed by `projects:UpdateProject`.

### Priced models

`require_priced_model` refuses a generation whose model no price row covers,
before the provider is called:

```bash
soat update-project --project-id proj_ABC --require_priced_model true
```

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

| What | Under the pause | On resume |
| --- | --- | --- |
| Agent, session and conversation generations, tool-output continuations, chat completions, direct tool calls | `409 PROJECT_PAUSED` | Accepted again |
| Orchestration run and eval run starts, manual and webhook trigger fires | `409 PROJECT_PAUSED`, no run or firing written | Accepted again |
| Event triggers | A `failed` firing with code `PROJECT_PAUSED` | Fire again |
| Schedule triggers | Not fired | Fire from their next occurrence after now; a missed one is not fired late |
| Live [orchestration runs](./orchestrations.md) | [Paused](./orchestrations.md): parked at the next checkpoint with `required_action.type: paused` and the project's `pause_reason` | Resumed in the background |
| Open [tasks](./workflows.md) | Automation paused: transitions work, state dispatches are suppressed | Suppressed dispatches run, as the caller who resumed |
| Queued [eval](./evaluations.md) items | Not claimed; the run stays `running` | Continue from where they stopped |

A generation, node or eval item already in flight finishes. Reads and writes keep working, so the project can be inspected and fixed while paused — including writes that embed content, such as document ingestion and memory writes, which are not starts. `loop` / `sub_orchestration` children started under the pause are born paused.

Pausing is idempotent and keeps the first reason. [`POST /api/v1/projects/{project_id}/resume`](/docs/api/projects/resume-project) (`projects:ResumeProject`) answers `409 PROJECT_NOT_PAUSED` on a running project, and is not offered to agents as a `soat` tool: deciding to spend again is left to a person or an explicit credential.

The resume hands back only what the pause held. A run or task an operator paused before the project was paused keeps its own pause; resuming one run or task on its own while the project is paused is `409 PROJECT_PAUSED`.

Both transitions emit a [webhook event](./webhooks.md): `projects.paused` and `projects.resumed`, each carrying the project.

### Deletion

Deleting a project with any dependent resource returns `409 Conflict`, code `PROJECT_HAS_DEPENDENTS`. Every project-scoped resource counts, including those accumulated while running:

- agents, AI providers, [model routes](./model-routes.md), tools, [ingestion rules](./ingestion-rules.md)
- actors, chats, conversations, sessions, [generations](./generations.md), [traces](./traces.md)
- [datasets and evals](./evaluations.md), [workflows and tasks](./workflows.md), [triggers](./triggers.md), [orchestrations](./orchestrations.md) and their runs
- [formations](./formations.md), [memories](./memories.md), [secrets](./secrets.md), [files](./files.md), [guardrails](./guardrails.md), [quotas](./quotas.md)
- [usage](./usage.md) history, and the [activity](./activity.md), [approval](./approvals.md), [exception](./exceptions.md) and guardrail-evaluation records of past runs

`?force=true` deletes all dependents in one transaction, including billing/usage history and the stored bytes of [files](./files.md).

The [audit log](./audit-log.md) is the exception: entries outlive the project with `project_id` cleared.

### Common Errors

| Status | Body                                            | Cause                                                                                                   | What to do                                                                                             |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `403`  | `{ "error": "Forbidden" }`                       | Caller isn't the `admin` role — creating, renaming, and deleting a project are admin-only               | Authenticate as the admin user, or have an admin perform the operation                                   |
| `403`  | `{ "error": "Forbidden" }`                       | [`GET /projects/{id}`](/docs/api/projects/get-project) (or a nested resource route) with a policy/API key that doesn't cover this project's SRN — e.g. a project key created for a **different** project | Check the caller's attached policies cover `srn:<this-project-id>:*:*`, or use a key scoped to this project — see [Project Access via Policies](#project-access-via-policies) |
| `404`  | —                                                | The project ID doesn't exist, or the caller can't see it because no policy grants access to it (existence isn't leaked) | Verify the ID; if it should exist, confirm a policy grants visibility — see [Visibility Rules](#visibility-rules) |
| `409`  | `{ "error": { "code": "PROJECT_HAS_DEPENDENTS" } }` | Deleting a project that still has dependent resources                                                  | Pass `?force=true`, or delete the dependent resources first — see [Deletion](#deletion)                   |
| `409`  | `{ "error": { "code": "PROJECT_PAUSED" } }` | Starting work — a generation, run, eval run, tool call or trigger fire — or resuming a run or task in a paused project | Resume the project once whatever paused it is resolved; `error.meta.pause_reason` says why — see [Pausing a project](#pausing-a-project) |
| `409`  | `{ "error": { "code": "PROJECT_NOT_PAUSED" } }` | Resuming a project that is not paused | Nothing to do; `paused_at` is `null` |
| `409`  | `{ "error": { "code": "MODEL_NOT_PRICED" } }` | A generation on a project with `require_priced_model` whose model carries no price row | Price the `(provider, model, component)` rows in `error.meta.unpriced_rows`, or set `require_priced_model` to `false` — see [Priced models](#priced-models) |
| `409`  | `{ "error": { "code": "PROJECT_DEFAULT_ROUTE_INHERITED" } }` | Clearing `default_model_route_id` while consumers that bind nothing inherit it — they would be left with no resolvable model | Bind those consumers explicitly (`meta.sample` names some), or repoint the default to another route, which is always allowed — see [Project default route](./model-routes.md#project-default-route) |

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

