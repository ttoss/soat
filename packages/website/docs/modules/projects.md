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

### Deletion

By default, deleting a project that has any dependent resource (agents, AI providers, tools, conversations, chats, formations, memories, actors, webhooks, secrets, sessions, files, traces, generations, orchestrations, etc.) returns `409 Conflict` with error code `PROJECT_HAS_DEPENDENTS`. Pass `?force=true` to delete all of those dependent resources along with the project itself, inside a single transaction.

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

