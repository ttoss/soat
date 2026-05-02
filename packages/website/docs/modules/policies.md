import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Policies

The Policies module provides global, reusable IAM policy documents that can be attached to users and API keys. Policies are managed by admins and define fine-grained permission rules evaluated at request time.

## Overview

A Policy is a named, reusable [policy document](./iam.md#policy-documents) stored globally — not scoped to any project. Policies are attached to **users** (via `PUT /users/:userId/policies`) and **API keys** (at creation or update time) to grant or restrict access.

Policies are identified by an `id` prefixed with `pol_`.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field         | Type   | Description                            |
| ------------- | ------ | -------------------------------------- |
| `id`          | string | Public identifier prefixed with `pol_` |
| `name`        | string | Human-readable policy name             |
| `description` | string | Optional description                   |
| `document`    | object | Policy document (see [IAM](./iam.md))  |
| `created_at`  | string | ISO 8601 creation timestamp            |
| `updated_at`  | string | ISO 8601 last-updated timestamp        |

## Key Concepts

### Policy Document

A policy document contains one or more statements. Each statement specifies an `effect` (`Allow` or `Deny`), a list of `action` strings, and an optional list of `resource` SRNs.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:ListDocuments"],
      "resource": ["soat:proj_ABC:document:*"]
    }
  ]
}
```

See [IAM — Policy Documents](./iam.md#policy-documents) for the full format and evaluation rules.

### Attaching Policies to Users

Users accumulate permissions from all policies attached to their account. When a user makes a request, all their policies are loaded and evaluated together.

```http
PUT /api/v1/users/usr_abc123/policies
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "policy_ids": ["pol_V1StGXR8Z5jdHi6B", "pol_YkQ9pLmNxR2wE4s"]
}
```

This operation **replaces** the user's full policy list.

### Attaching Policies to API Keys

API keys can also have policies attached. When an API key has policies, the effective permissions are the **intersection** of the owning user's policies and the key's own policies — the key can never exceed the user's permissions. If a key has no policies attached, it inherits the user's full permissions.

See [API Keys](./api-keys.md) for details.

### SRN Scoping

Because policies are global (not project-scoped), resource SRNs in policy statements carry the full project identifier:

```json
{ "resource": ["soat:proj_ABC:document:*"] }
```

Use `soat:*:*:*` to grant access across all projects (admin-level). Use project-specific SRNs to restrict a policy to a single project without scoping the API key to that project.

## Examples

### Create a policy

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-policy \
  --name "Read Only Documents" \
  --document '{"statement":[{"effect":"Allow","action":["documents:GetDocument","documents:ListDocuments"],"resource":["soat:proj_ABC:document:*"]}]}'
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

const { data, error } = await soat.policies.createPolicy({
  body: {
    name: 'Read Only Documents',
    document: {
      statement: [
        {
          effect: 'Allow',
          action: ['documents:GetDocument', 'documents:ListDocuments'],
          resource: ['soat:proj_ABC:document:*'],
        },
      ],
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/policies \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Read Only Documents",
    "document": {
      "statement": [{
        "effect": "Allow",
        "action": ["documents:GetDocument", "documents:ListDocuments"],
        "resource": ["soat:proj_ABC:document:*"]
      }]
    }
  }'
```

</TabItem>
</Tabs>

### Attach policies to a user

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat attach-user-policies \
  --user-id usr_01 \
  --policy-ids pol_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.users.attachUserPolicies({
  path: { user_id: 'usr_01' },
  body: { policy_ids: ['pol_V1StGXR8Z5jdHi6B'] },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PUT https://api.example.com/api/v1/users/usr_01/policies \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"policy_ids": ["pol_V1StGXR8Z5jdHi6B"]}'
```

</TabItem>
</Tabs>
