import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# API Keys

The API Keys module provides long-lived programmatic credentials for users. An API key authenticates as its owning user and optionally restricts access to a single project and/or a subset of that user's policies.

## Overview

API keys are prefixed with `sk_` and are identified in the system by a public `id` prefixed with `key_`. The raw key value is returned **only at creation time** and cannot be retrieved again. A truncated `key_prefix` (first 8 characters) is stored for identification.

API keys use the standard `Authorization: Bearer <key>` header — the same as JWTs.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field        | Type     | Description                                                                   |
| ------------ | -------- | ----------------------------------------------------------------------------- |
| `id`         | string   | Public identifier prefixed with `key_`                                        |
| `name`       | string   | Human-readable label                                                          |
| `key_prefix` | string   | First 8 characters of the raw key (for identification, never the full secret) |
| `user_id`    | string   | Public ID of the owning user                                                  |
| `project_id` | string   | Optional — restricts key to a single project                                  |
| `policy_ids` | string[] | Optional — public IDs of policies that further restrict key permissions       |
| `created_at` | string   | ISO 8601 creation timestamp                                                   |
| `updated_at` | string   | ISO 8601 last-updated timestamp                                               |

## Key Concepts

### Permission Inheritance

The effective permissions of an API key depend on what is attached to it:

| Configuration                      | Effective permissions                                                      |
| ---------------------------------- | -------------------------------------------------------------------------- |
| No `project_id`, no `policy_ids`   | Full user permissions across all projects                                  |
| `project_id` only                  | User permissions, restricted to that project                               |
| `policy_ids` only                  | Intersection of user policies and key policies, across all projects        |
| Both `project_id` and `policy_ids` | Intersection of user policies and key policies, restricted to that project |

**Intersection semantics:** when a key has `policy_ids`, both the user's policies **and** the key's own policies must independently allow the requested action. The key can never exceed the permissions of the user who owns it.

### Project Scoping

When `project_id` is set on a key, any request made with that key is hard-locked to that project. Attempts to access resources in any other project are denied regardless of what the policies say.

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
