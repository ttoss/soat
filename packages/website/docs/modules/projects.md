import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Projects

The Projects module provides multi-tenant namespaces in SOAT. Every resource ([document](./documents.md), [file](./files.md), [actor](./actors.md), [conversation](./conversations.md)) belongs to a project. Projects are identified by an `id` prefixed with `proj_`.

## Overview

A Project is a top-level container that scopes all resources. Users access projects through policy-based authorization — there is no separate membership table. Whether a user can access a project is determined entirely by the [policies](./policies.md) attached to their account and the SRN patterns those policies contain.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field        | Type   | Description                             |
| ------------ | ------ | --------------------------------------- |
| `id`         | string | Public identifier prefixed with `proj_` |
| `name`       | string | Human-readable project name             |
| `created_at` | string | ISO 8601 creation timestamp             |
| `updated_at` | string | ISO 8601 last-updated timestamp         |

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

### Security Model

- The raw key is a 32-byte random value prefixed with `pk_`.
- Only the `key_prefix` (first 8 characters) and a bcrypt hash of the full key are stored.
- Authentication works by matching the prefix to candidate rows, then verifying the full key against each hash.

### Intersection Authorization

When an project key is used to make a request, authorization applies **intersection semantics**:

1. The owning user's project membership policies must allow the action.
2. The key's own attached policy must also allow the action.

Both must independently evaluate to `Allow`. This ensures a key can never exceed the permissions of the user who created it.

### Scoping

A project key is scoped to exactly one project. Requests made with the key can only access resources within that project. The project is resolved automatically from the key — callers do not need to specify the project explicitly.

### API Key Permissions

Project key operations require authentication. The creator of a key is the only user who can read or update it (ownership enforcement).

| Action            | Permission     | REST Endpoint              | MCP Tool |
| ----------------- | -------------- | -------------------------- | -------- |
| Create key        | Project member | `POST /api/v1/api-keys`    | —        |
| Get key by ID     | Key owner only | `GET /api/v1/api-keys/:id` | —        |
| Update key policy | Key owner only | `PUT /api/v1/api-keys/:id` | —        |
