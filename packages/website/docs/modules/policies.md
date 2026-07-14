---
description: "Global, reusable IAM policy documents attached to users and API keys, defining fine-grained rules evaluated at request time."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Policies

The Policies module provides global, reusable IAM policy documents that can be attached to users and API keys. Policies are managed by admins and define fine-grained permission rules evaluated at request time.

## Overview

A Policy is a named, reusable [policy document](./iam.md#policy-documents) stored globally — not scoped to any project. Policies are attached to **users** and **API keys** to grant or restrict access. The policies attached to a given user can be listed by filtering on that user.

Policies are identified by an `id` prefixed with `pol_`.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies)
- [Permissions in Practice - Step 5 (Attach policies to users)](/docs/tutorials/permissions#step-5--attach-policies-to-users)
- [Agent SOAT Tools and Preset Parameters - Step 5 (Create user alice with a restricted policy)](/docs/tutorials/agent-soat-tools#step-5--create-user-alice-with-a-restricted-policy)

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

See [IAM — Policy Documents](./iam.md#policy-documents) for the full format and evaluation rules. For a worked example of authoring full-access and read-only documents, see [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies).

### Attaching Policies to Users

Users accumulate permissions from all policies attached to their account. When a user makes a request, all their policies are loaded and evaluated together. Attaching a policy set to a user **replaces** the user's full policy list. See it end to end in [Permissions in Practice - Step 5 (Attach policies to users)](/docs/tutorials/permissions#step-5--attach-policies-to-users), and the [Attach policies to a user](#attach-policies-to-a-user) example below.

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
  --user-id user_01 \
  --policy-ids pol_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.users.attachUserPolicies({
  path: { user_id: 'user_01' },
  body: { policy_ids: ['pol_V1StGXR8Z5jdHi6B'] },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PUT https://api.example.com/api/v1/users/user_01/policies \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"policy_ids": ["pol_V1StGXR8Z5jdHi6B"]}'
```

</TabItem>
</Tabs>
