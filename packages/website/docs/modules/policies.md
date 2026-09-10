---
description: "Global, reusable IAM policy documents attached to users and API keys, defining fine-grained rules evaluated at request time."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Policies

Global, reusable IAM policy documents attached to users and API keys; managed by admins, evaluated at request time.

## Overview

A Policy is a named [policy document](./iam.md#policy-documents) stored globally, attached to **users** and **API keys**. Filter the listing by user to see a user's policies. Ids are prefixed `pol_`.

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

Each statement has an `effect` (`Allow` or `Deny`), `action` strings, and optional `resource` SRNs.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:ListDocuments"],
      "resource": ["srn:proj_ABC:document:*"]
    }
  ]
}
```

Format and evaluation: [IAM — Policy Documents](./iam.md#policy-documents). Example: [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies).

### Attaching Policies to Users

All of a user's policies are evaluated together. Attaching **replaces** the full list. See [Permissions in Practice - Step 5 (Attach policies to users)](/docs/tutorials/permissions#step-5--attach-policies-to-users), and the [Attach policies to a user](#attach-policies-to-a-user) example below.

### Attaching Policies to API Keys

With key policies, effective permissions are the **intersection** of the user's and the key's; a key never exceeds its user. Without them, the key inherits the user's permissions. See [API Keys](./api-keys.md).

### SRN Scoping

Policies are global, so resource SRNs carry the full project identifier:

```json
{ "resource": ["srn:proj_ABC:document:*"] }
```

`srn:*:*:*` grants all projects (admin-level); a project-specific SRN restricts a policy to one project without scoping the API key.

## Examples

### Create a policy

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-policy \
  --name "Read Only Documents" \
  --document '{"statement":[{"effect":"Allow","action":["documents:GetDocument","documents:ListDocuments"],"resource":["srn:proj_ABC:document:*"]}]}'
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
          resource: ['srn:proj_ABC:document:*'],
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
        "resource": ["srn:proj_ABC:document:*"]
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
