---
description: "Long-lived programmatic credentials that authenticate as their owning user, optionally scoped to a project, with optional policy restrictions."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# API Keys

The API Keys module provides long-lived programmatic credentials for users. An API key authenticates as its owning user, is optionally scoped to a single project, and optionally restricts access to a subset of that user's policies.

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
| `project_id` | string \| null | Optional — the single project this key is scoped to, or `null` for an unscoped key that spans projects |
| `policy_ids` | string[] | Optional — public IDs of policies that further restrict key permissions       |
| `created_at` | string   | ISO 8601 creation timestamp                                                   |
| `updated_at` | string   | ISO 8601 last-updated timestamp                                               |

## Key Concepts

### Permission Inheritance

A key may be scoped to one project or left unscoped; `policy_ids` optionally narrow it further:

| Configuration                | Effective permissions                                                          |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `project_id` only            | User permissions, restricted to that project                                   |
| `project_id` + `policy_ids`  | Intersection of user policies and key policies, restricted to that project     |
| unscoped (no `project_id`)   | User permissions, across every project the user can reach                      |
| unscoped + `policy_ids`      | Intersection of user policies and key policies, across every reachable project |

**Intersection semantics:** when a key has `policy_ids`, both the user's policies **and** the key's own policies must independently allow the requested action. The key can never exceed the permissions of the user who owns it — scoping to a project or leaving it unscoped only changes which projects the ceiling applies to, never raises it. See this ceiling demonstrated end to end in [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions), where a key granted a full-access policy is still limited to its owner's read-only permissions.

### Project Scoping

`project_id` is **optional**.

- **Scoped key** (`project_id` set): any request made with the key is hard-locked to its project; attempts to access resources in any other project are denied regardless of what the policies say.
- **Unscoped key** (`project_id` omitted or null): the key is not confined to any project. It can operate across every project its owner can reach, bounded by the intersection of the owner's permissions and the key's own `policy_ids`. Use IAM policies (on the user or the key) to control which projects and actions such a key may touch. Because an unscoped key has no implicit project, a `project_id` must be supplied explicitly on requests that operate on a specific project.

An update may re-scope a key to a different project, scope a previously unscoped key, or clear the scope with `project_id: null`. For a worked example of creating project-scoped keys, see [Permissions in Practice - Step 6 (Create API keys)](/docs/tutorials/permissions#step-6--create-api-keys).

#### Implicit project id

Because a project-scoped key already identifies its project, `project_id` is **optional** on requests made with such a key:

- Omit `project_id` and the request defaults to the key's project. An agent using a project-scoped MCP connector can upload a file, list files, create documents, etc. without first calling `list-projects`.
- Supply a `project_id` that matches the key's project and it is accepted.
- Supply a `project_id` that belongs to a different project and the request is rejected with `403`.

JWT auth is unchanged: a write that omits `project_id` still returns `400`, since a concrete project is never inferred from a user's set of accessible projects.

### Policy Attachment

Policies listed in `policy_ids` are loaded from the global [Policies](./policies.md) store. `policy_ids` is the list of policy public IDs (`pol_`-prefixed) attached to the key; the REST API accepts and returns these public IDs.

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

### List API keys

The raw secret is never included in list or get responses — only the `key_prefix` is returned.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-api-keys
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.apiKeys.listApiKeys();
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/api-keys \
  -H "Authorization: Bearer <jwt-token>"
```

</TabItem>
</Tabs>
