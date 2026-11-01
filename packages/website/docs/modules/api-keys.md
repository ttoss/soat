---
description: "Long-lived programmatic credentials that authenticate as their owning user, optionally scoped to a project, with optional policy restrictions."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# API Keys

Long-lived programmatic credentials that authenticate as their owning user, optionally scoped to one project and optionally restricted to a subset of the user's policies.

## Overview

Keys are prefixed `sk_` with a public `id` prefixed `key_`. The raw value is returned **only at creation**; the server never stores it, only its SHA-256 and a `key_prefix` (first 8 characters) for identification. A key is 32 random bytes, so a fast hash is enough to keep it unrecoverable, and a request pays one indexed lookup to verify it. Deleting a key refuses its next request. Keys use `Authorization: Bearer <key>`, like JWTs.

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

The `project_id` binding is enforced **before**, and independently of, the owner's role. An `admin`-owned scoped key stays confined to its project: it may update or delete that project, but a resource write naming another project returns `403 API_KEY_PROJECT_SCOPE`, and a resource in another project addressed by id is `404`, as an id that names nothing is.

The instance-wide admin operations — [users](./users.md), [policies](./policies.md), creating a project, the [price book](./usage.md) and `policy` resources in a [formation](./formations.md) — take an admin credential with no boundary of its own: a login token, or an admin's key with no `project_id` and no `policy_ids`. An admin's scoped key, policy-narrowed key or OAuth token gets `403`.

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

Otherwise a key confined to `proj_A` could mint an unscoped key for the same owner and operate anywhere. Rotation still works within the key's own project. A project-scoped token writes no key at all; see [A project-scoped token writes no key](#a-project-scoped-token-writes-no-key).

Owner-or-admin applies on top: the project check decides *which* keys are visible, the owner check whether the caller may act on them. The listing is narrowed to the caller's own keys by default (confinement to a project is not authority over it); a credential holding `api-keys:ListApiKeys` on the project reads the whole inventory.

### Policy Attachment

`policy_ids` are `pol_`-prefixed public IDs from the global [Policies](./policies.md) store; the REST API accepts and returns them.

### Narrowing a key to a capability set

A key's `policy_ids` is its capability set. The vocabulary is the IAM action strings in the [Permissions Reference](../permissions.md) (`secrets:ListSecrets`, `files:GetFile`, …); a policy naming an unknown action is refused at creation. A service fronting SOAT narrows a credential by minting one key per capability set: [create a policy](./policies.md) allowing those actions, then [create a key](#create-an-api-key) with it in `policy_ids`.

A request with that key for an action outside the set is `403 FORBIDDEN`, whatever its owner may do.

### A narrowed key stays inside its boundary

Key management is self-service, so the boundary also guards the key being written. Under a key whose `policy_ids` are `[pol_A, pol_B]`:

| Operation | Behavior |
| --- | --- |
| [`POST /api-keys`](/docs/api/api-keys/create-api-key) with no `policy_ids` | Mints a key with `policy_ids: [pol_A, pol_B]` |
| [`POST /api-keys`](/docs/api/api-keys/create-api-key) or [`PUT /api-keys/{id}`](/docs/api/api-keys/update-api-key) with `policy_ids: [pol_A]` | Accepted |
| Either with `policy_ids: []`, or naming `pol_C` | `403 API_KEY_POLICY_BOUNDARY` |
| [`PUT /api-keys/{id}`](/docs/api/api-keys/update-api-key) with no `policy_ids` | Leaves the stored list unchanged |

`meta` carries `boundary_policy_ids` and `requested_policy_ids`. Otherwise a narrowed key could mint a policy-less key for the same owner and act with the owner's full permissions. An `api_key` [formation](./formations.md) resource follows the same table.

### A project-scoped token writes no key

An OAuth access token, a trigger run-as token and a run token carry their boundary inside the token (the consented scope, the trigger's policy, the starting key's policies), and a key cannot carry it. Under any of them, [`POST /api-keys`](/docs/api/api-keys/create-api-key), [`PUT /api-keys/{id}`](/docs/api/api-keys/update-api-key) and an `api_key` [formation](./formations.md) resource return `403 API_KEY_SCOPED_TOKEN`. Create and update keys with a user token or an API key; reading, listing and deleting keys are unaffected.

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
