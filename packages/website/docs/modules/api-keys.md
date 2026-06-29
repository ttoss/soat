import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# API Keys

The API Keys module provides long-lived programmatic credentials for users. An API key authenticates as its owning user, is always scoped to a single project, and optionally restricts access to a subset of that user's policies.

## Overview

API keys are prefixed with `sk_` and are identified in the system by a public `id` prefixed with `key_`. The raw key value is returned **only at creation time** and cannot be retrieved again. A truncated `key_prefix` (first 8 characters) is stored for identification.

API keys use the standard `Authorization: Bearer <key>` header — the same as JWTs.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Permissions in Practice - Step 6 (Create API keys)](/docs/tutorials/permissions#step-6--create-api-keys)
- [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions)

## Data Model

| Field        | Type     | Description                                                                   |
| ------------ | -------- | ----------------------------------------------------------------------------- |
| `id`         | string   | Public identifier prefixed with `key_`                                        |
| `name`       | string   | Human-readable label                                                          |
| `key_prefix` | string   | First 8 characters of the raw key (for identification, never the full secret) |
| `user_id`    | string   | Public ID of the owning user                                                  |
| `project_id` | string   | Required — the single project this key is scoped to                           |
| `policy_ids` | string[] | Optional — public IDs of policies that further restrict key permissions       |
| `created_at` | string   | ISO 8601 creation timestamp                                                   |
| `updated_at` | string   | ISO 8601 last-updated timestamp                                               |

## Key Concepts

### Permission Inheritance

Every key is scoped to one project; `policy_ids` optionally narrow it further:

| Configuration              | Effective permissions                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `project_id` only          | User permissions, restricted to that project                               |
| `project_id` + `policy_ids` | Intersection of user policies and key policies, restricted to that project |

**Intersection semantics:** when a key has `policy_ids`, both the user's policies **and** the key's own policies must independently allow the requested action. The key can never exceed the permissions of the user who owns it. See this ceiling demonstrated end to end in [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions), where a key granted a full-access policy is still limited to its owner's read-only permissions.

### Project Scoping

`project_id` is **required** at creation — a key cannot span projects. Any request made with the key is hard-locked to its project; attempts to access resources in any other project are denied regardless of what the policies say. An update may re-scope a key to a different project but can never clear the scope. For a worked example of creating project-scoped keys, see [Permissions in Practice - Step 6 (Create API keys)](/docs/tutorials/permissions#step-6--create-api-keys).

#### Implicit project id

Because a project-scoped key already identifies its project, `project_id` is **optional** on requests made with such a key:

- Omit `project_id` and the request defaults to the key's project. An agent using a project-scoped MCP connector can upload a file, list files, create documents, etc. without first calling `list-projects`.
- Supply a `project_id` that matches the key's project and it is accepted.
- Supply a `project_id` that belongs to a different project and the request is rejected with `403`.

JWT auth is unchanged: a write that omits `project_id` still returns `400`, since a concrete project is never inferred from a user's set of accessible projects.

### Policy Attachment

Policies listed in `policy_ids` are loaded from the global [Policies](./policies.md) store. The `policy_ids` list on a key stores integer internal IDs; the REST API accepts and returns the public `pol_`-prefixed IDs.

### Revoking a Key

Delete the key via `DELETE /api/v1/api-keys/:id`. The key immediately stops authenticating. There is no rotation endpoint — create a new key and delete the old one.

## Examples

### Create an API key

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-api-key \
  --name "CI/CD Pipeline" \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --policy-ids pol_V1StGXR8Z5jdHi6B
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

const { data, error } = await soat.apiKeys.createApiKey({
  body: {
    name: 'CI/CD Pipeline',
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    policy_ids: ['pol_V1StGXR8Z5jdHi6B'],
  },
});
if (error) throw new Error(JSON.stringify(error));
// data.key is the raw secret — store it securely, it is never returned again
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/api-keys \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CI/CD Pipeline",
    "project_id": "proj_V1StGXR8Z5jdHi6B",
    "policy_ids": ["pol_V1StGXR8Z5jdHi6B"]
  }'
```

</TabItem>
</Tabs>

Store the `key` value securely — it is never returned again.
