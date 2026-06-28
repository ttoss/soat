import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Projects

The Projects module provides multi-tenant namespaces in SOAT. Every resource ([document](./documents.md), [file](./files.md), [actor](./actors.md), [conversation](./conversations.md)) belongs to a project. Projects are identified by an `id` prefixed with `proj_`.

## Overview

A Project is a top-level container that scopes all resources. Users access projects through policy-based authorization — there is no separate membership table. Whether a user can access a project is determined entirely by the [policies](./policies.md) attached to their account and the SRN patterns those policies contain. The [members API](#project-members) is a thin convenience layer over this same policy mechanism. For a project creation walkthrough, see [Chat with an LLM - Step 2 (Create a project)](/docs/tutorials/chat-with-llm#step-2--create-a-project).

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

### Project Member

Returned by the [members API](#project-members).

| Field        | Type   | Description                                |
| ------------ | ------ | ------------------------------------------ |
| `project_id` | string | Public project ID (`proj_` prefix)         |
| `user_id`    | string | Public user ID (`usr_` prefix)             |
| `username`   | string | The member's username                      |
| `role`       | string | The member's account role (`admin`/`user`) |

## Key Concepts

### Project Access via Policies

Users no longer need to be explicitly added to a project as members. Access is granted by attaching a [Policy](./policies.md) to the user (or their API key) that contains an `Allow` statement covering the relevant project's SRN pattern:

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

Authorization is policy-only — there is no Layer 1 membership gate. All access decisions are evaluated through the policy engine against the requested action and the resource SRN. See [IAM](./iam.md) for details.

### Project Members

The members API (`POST`/`GET`/`DELETE /api/v1/projects/{project_id}/members`) is a discoverable shortcut for the most common access grant: full access to a single project. It manages a single **managed membership policy** per project — a [Policy](./policies.md) named `member:<project_id>` whose statement is:

```json
{
  "statement": [
    { "effect": "Allow", "action": ["*"], "resource": ["soat:<project_id>:*:*"] }
  ]
}
```

- **Adding a member** attaches that policy to the user (creating it on first use). The call is idempotent.
- **Removing a member** detaches the policy from the user.
- **Listing members** returns the users to whom the managed policy is attached.

All four operations require the **admin** role.

Because membership is just a managed policy, the members API only reports access granted through itself. A user who can reach the project via a different policy (e.g. a broad `soat:*:*:*` grant) or via the admin role is **not** listed as a member, and cannot be removed through this API. For finer-grained or cross-project access, author [policies](./policies.md) directly.

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

### Add a member to a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat add-project-member --project-id proj_ABC --user-id usr_XYZ
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.projects.addProjectMember({
  path: { project_id: 'proj_ABC' },
  body: { user_id: 'usr_XYZ' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/projects/proj_ABC/members \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "usr_XYZ"}'
```

</TabItem>
</Tabs>

