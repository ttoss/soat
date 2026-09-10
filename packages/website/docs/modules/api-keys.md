---
description: "Long-lived programmatic credentials that authenticate as their owning user, optionally scoped to a project, with optional policy restrictions."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# API Keys

Long-lived programmatic credentials that authenticate as their owning user, optionally scoped to one project and optionally restricted to a subset of the user's policies.

## Overview

Keys are prefixed `sk_` with a public `id` prefixed `key_`. The raw value is returned **only at creation**; a `key_prefix` (first 8 characters) is stored for identification. Keys use `Authorization: Bearer <key>`, like JWTs.

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

Scope and `policy_ids` combine as:

| Configuration                | Effective permissions                                                          |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `project_id` only            | User permissions, restricted to that project                                   |
| `project_id` + `policy_ids`  | Intersection of user policies and key policies, restricted to that project     |
| unscoped (no `project_id`)   | User permissions, across every project the user can reach                      |
| unscoped + `policy_ids`      | Intersection of user policies and key policies, across every reachable project |

**Intersection semantics:** with `policy_ids`, the user's policies **and** the key's must both allow the action; a key never exceeds its owner, and scoping only changes which projects the ceiling applies to. Demonstrated in [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions).

### Project Scoping

`project_id` is **optional**.

- **Scoped key** (`project_id` set): hard-locked to its project; other projects are denied regardless of policy. See [Project scope is a hard boundary, even for admins](#project-scope-is-a-hard-boundary-even-for-admins).
- **Unscoped key** (`project_id` omitted or null): operates across every project its owner can reach, bounded by the intersection of the owner's permissions and `policy_ids`. Requests on a specific project must supply `project_id` explicitly.

An update may re-scope, scope, or clear scope with `project_id: null`. Example: [Permissions in Practice - Step 6 (Create API keys)](/docs/tutorials/permissions#step-6--create-api-keys).

#### Implicit project id

With a project-scoped key `project_id` is **optional** on requests:

- Omitted: defaults to the key's project, so a project-scoped MCP connector can upload files, list files, create documents, etc. without `list-projects`.
- Matching the key's project: accepted.
- A different project: `403` with the `API_KEY_PROJECT_SCOPE` error code; the message names both projects and `meta` carries `scoped_project` / `requested_project`:

  ```json
  {
    "error": {
      "code": "API_KEY_PROJECT_SCOPE",
      "message": "This API key is scoped to project 'proj_A' and cannot access project 'proj_B'. Mint a key scoped to 'proj_B' (or an unscoped key) to operate there.",
      "meta": { "scoped_project": "proj_A", "requested_project": "proj_B" }
    }
  }
  ```

JWT auth is unchanged: a write omitting `project_id` returns `400`; a project is never inferred from a user's accessible set.

### Project scope is a hard boundary, even for admins

The `project_id` binding is enforced **before**, and independently of, the owner's role. An `admin`-owned key can create and delete projects (role-gated, not project-tied), but for resource operations (secrets, formations, files, webhooks, etc.) it stays confined to its project.

So one scoped key cannot both create a project **and** provision inside it: create the project, then mint a key scoped to it (or use an unscoped key). A cross-project resource write returns `403 API_KEY_PROJECT_SCOPE`.

### The boundary covers key management itself

Key creation is self-service, so the binding also guards the credential being written. Under a credential scoped to `proj_A`:

| Operation | Behavior under a credential scoped to `proj_A` |
| --- | --- |
| [`POST /api-keys`](/docs/api/api-keys/create-api-key) with no `project_id` | Mints a key scoped to `proj_A` (the [implicit project id](#implicit-project-id)) |
| [`POST /api-keys`](/docs/api/api-keys/create-api-key) with `project_id: proj_B` | `403 API_KEY_PROJECT_SCOPE` |
| [`POST /api-keys`](/docs/api/api-keys/create-api-key) with `project_id: null` | `403` — minting an **unscoped** key requires an unscoped credential |
| `GET` / `PUT` / [`DELETE /api-keys/{id}`](/docs/api/api-keys/delete-api-key) for a key in `proj_B`, or for an unscoped key | `403 API_KEY_PROJECT_SCOPE` |
| [`PUT /api-keys/{id}`](/docs/api/api-keys/update-api-key) moving a `proj_A` key to `proj_B`, or clearing its scope | `403` — both ends of a re-scope are checked |
| [`GET /api-keys`](/docs/api/api-keys/list-api-keys) (list) | Returns the caller's own keys in `proj_A`, or every key in `proj_A` when the credential holds `api-keys:ListApiKeys` on the project |

Otherwise a key confined to `proj_A` could mint an unscoped key for the same owner and operate anywhere. Rotation still works within the key's own project.

Owner-or-admin applies on top: the project check decides *which* keys are visible, the owner check whether the caller may act on them. The listing is narrowed to the caller's own keys by default (confinement to a project is not authority over it); a credential holding `api-keys:ListApiKeys` on the project reads the whole inventory.

### Policy Attachment

`policy_ids` are `pol_`-prefixed public IDs from the global [Policies](./policies.md) store; the REST API accepts and returns them.

### Revoking a Key

[`DELETE /api/v1/api-keys/:id`](/docs/api/api-keys/delete-api-key) stops the key immediately. There is no rotation endpoint: create a new key, delete the old.

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

List and get responses carry only `key_prefix`, never the raw secret.

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
