---
description: "Multi-tenant namespaces in SOAT; every document, file, actor, and conversation belongs to a project."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Projects

The Projects module provides multi-tenant namespaces in SOAT. Every resource ([document](./documents.md), [file](./files.md), [actor](./actors.md), [conversation](./conversations.md)) belongs to a project. Projects are identified by an `id` prefixed with `proj_`.

## Overview

A Project is a top-level container that scopes all resources. Users access projects through policy-based authorization — there is no separate membership table. Whether a user can access a project is determined entirely by the [policies](./policies.md) attached to their account and the SRN patterns those policies contain. For a project creation walkthrough, see [Chat with an LLM - Step 2 (Create a project)](/docs/tutorials/chat-with-llm#step-2--create-a-project).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 2 (Create a project)](/docs/tutorials/chat-with-llm#step-2--create-a-project)
- [Permissions in Practice - Step 3 (Create the Analytics project)](/docs/tutorials/permissions#step-3--create-the-analytics-project)
- [Deploy a Multi-Agent App with Agent Formation - Step 2 (Create a project)](/docs/tutorials/formations#step-2--create-a-project)

## Data Model

| Field        | Type   | Description                             |
| ------------ | ------ | --------------------------------------- |
| `id`         | string | Public identifier prefixed with `proj_` |
| `name`       | string | Human-readable project name             |
| `guardrail_ids` | array | Guardrails attached at the project scope — the baseline governing every tool call by every agent in the project. See [Guardrails — Attachment](./guardrails.md#attachment) |
| `default_model_route_id` | string \| null | [Model route](./model-routes.md#project-default-route) inherited by consumers in this project that bind neither `model_route_id` nor `ai_provider_id`. `null` (default) means no default, so every consumer must bind explicitly. Settable/clearable via `update-project`. |
| `max_concurrent_runs` | integer \| null | Maximum [orchestration runs](./orchestrations.md#concurrency-limits) of this project driven at once. `null` (default) means unlimited; otherwise an integer ≥ 1. Settable/clearable via `update-project`. |
| `audit_reads_enabled` | boolean | Opts the project into [read auditing](./audit-log.md#read-auditing): when `true`, `GET` requests naming this project are recorded in the audit log alongside mutations. `false` by default. Settable via `update-project`. |
| `trace_content_retention_days` | integer \| null | Days of [trace/generation content retention](./traces.md#retention-policy) before the daily sweep purges it. `null` (default) disables retention; otherwise an integer ≥ 1. Settable/clearable via `update-project`. |
| `trace_content_mode` | string | `full` (default) or `none`. `none` is [zero-retention](./traces.md#zero-retention-mode): trace and generation content is never written for any agent in the project. Settable via `update-project`. |
| `created_at` | string | ISO 8601 creation timestamp             |
| `updated_at` | string | ISO 8601 last-updated timestamp         |

## Key Concepts

### Project Access via Policies

Project access is entirely policy-driven; there is no membership list to maintain. Access is granted by attaching a [Policy](./policies.md) to the user (or their API key) that contains an `Allow` statement covering the relevant project's SRN pattern:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["projects:GetProject", "files:ListFiles", "files:GetFile"],
      "resource": ["soat:proj_ABC:*:*"]
    }
  ]
}
```

For a complete scoped-access walkthrough, see [Permissions in Practice - Step 3 (Create the Analytics project)](/docs/tutorials/permissions#step-3--create-the-analytics-project).

To grant a user access to all projects, use a wildcard project segment:

```json
{ "resource": ["soat:*:*:*"] }
```

### Visibility Rules

- **Admin users** see all projects.
- **API key callers** scoped to a project see only that project.
- **Regular users** see only the projects covered by the SRN patterns in their attached policies.

### Authorization Model

Authorization is policy-only. All access decisions are evaluated through the policy engine against the requested action and the resource SRN. See [IAM](./iam.md) for details.

To grant a user access to a single project, attach a [Policy](./policies.md) scoped to that project's SRN. A project-scoped grant is honored by every project endpoint, including `GET /projects/{id}`:

```json
{
  "statement": [
    { "effect": "Allow", "action": ["*"], "resource": ["soat:proj_ABC:*:*"] }
  ]
}
```

### Default Model Route

`default_model_route_id` names the [model route](./model-routes.md) every consumer in the project inherits when it binds neither `model_route_id` nor `ai_provider_id` — a single project-scoped switch that gives agents, chats, discussions, and memory completions provider failover without editing each one.

```bash
soat update-project --project-id proj_… --default_model_route_id route_…
```

The route must belong to this project. An explicit binding on a consumer always wins, so the default can never override a deliberate pin. Repointing the default to another route is free; **clearing** it returns `409 PROJECT_DEFAULT_ROUTE_INHERITED` while any consumer inherits it, and deleting the route itself returns `409 MODEL_ROUTE_HAS_DEPENDENTS`. Governed by `projects:UpdateProject`.

### Deletion

By default, deleting a project that has any dependent resource (agents, AI providers, tools, conversations, chats, formations, memories, actors, webhooks, secrets, sessions, files, traces, generations, orchestrations, [usage](./usage.md) history, etc.) returns `409 Conflict` with error code `PROJECT_HAS_DEPENDENTS`. Pass `?force=true` to delete all of those dependent resources along with the project itself, inside a single transaction.

Usage history counts as a dependent for the same reason as every other resource above: `force=true` is the explicit acknowledgment that billing history for the project is being destroyed, not a silent side effect of an unrelated cleanup.

Deleting the project's [files](./files.md) — including trace content and uploaded documents — also removes their stored bytes from the active storage backend, not just their database rows, so a force-deleted project leaves nothing behind in storage.

### Common Errors

| Status | Body                                            | Cause                                                                                                   | What to do                                                                                             |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `403`  | `{ "error": "Forbidden" }`                       | Caller isn't the `admin` role — creating, renaming, and deleting a project are admin-only               | Authenticate as the admin user, or have an admin perform the operation                                   |
| `403`  | `{ "error": "Forbidden" }`                       | `GET /projects/{id}` (or a nested resource route) with a policy/API key that doesn't cover this project's SRN — e.g. a project key created for a **different** project | Check the caller's attached policies cover `soat:<this-project-id>:*:*`, or use a key scoped to this project — see [Authorization Model](#authorization-model) |
| `404`  | —                                                | The project ID doesn't exist, or the caller can't see it because no policy grants access to it (existence isn't leaked) | Verify the ID; if it should exist, confirm a policy grants visibility — see [Visibility Rules](#visibility-rules) |
| `409`  | `{ "error": { "code": "PROJECT_HAS_DEPENDENTS" } }` | Deleting a project that still has dependent resources                                                  | Pass `?force=true`, or delete the dependent resources first — see [Deletion](#deletion)                   |
| `409`  | `{ "error": { "code": "PROJECT_DEFAULT_ROUTE_INHERITED" } }` | Clearing `default_model_route_id` while consumers that bind nothing inherit it — they would be left with no resolvable model | Bind those consumers explicitly (`meta.sample` names some), or repoint the default to another route, which is always allowed — see [Project default route](./model-routes.md#project-default-route) |

Project-scoped access is entirely policy-driven (there is no membership list), so a `403` on a project route almost always means the caller's current policies don't include an `Allow` statement covering that project's SRN — see [Project Access via Policies](#project-access-via-policies).

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

### Rename a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id proj_ABC --name "Renamed Project"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.projects.updateProject({
  path: { project_id: 'proj_ABC' },
  body: { name: 'Renamed Project' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/projects/proj_ABC \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Renamed Project"}'
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

