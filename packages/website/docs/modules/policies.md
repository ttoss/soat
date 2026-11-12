---
description: 'Reusable IAM policy documents, global or owned by one project, attached to users, API keys, agents, triggers and webhooks and evaluated at request time.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Policies

Reusable IAM policy documents, global or owned by one project, evaluated at request time.

## Overview

A Policy is a named [policy document](./iam.md#policy-documents), either **global** or a **project policy** (see [Project and Global Policies](#project-and-global-policies)), attached to **users** and **API keys**. Filter the listing by project, or (unrestricted admin) by user. Ids are prefixed `pol_`. A policy a trigger names in its [`policy_ids`](./triggers.md#execution-identity), an agent in its [`policy_ids`](./agents.md#execution-identity), or a webhook in its [`policy_ids`](./webhooks.md#policy-ids-and-the-read-guard), cannot be deleted (`409 POLICY_HAS_DEPENDENTS`); detach it first. Whoever creates or edits a trigger, agent, webhook or user holds every grant of the policies it carries after the write, whichever fields the write names (`403 POLICY_GRANT_NOT_HELD`). Editing a policy a trigger, an agent, a webhook, an API key or a user carries needs an editor who holds its new grants where that carrier acts (`403 POLICY_GRANT_NOT_HELD`, see [Execution Identity](./triggers.md#execution-identity)): the resource's or a project-scoped key's project, else every project, which a project policy narrows to its own. A key narrowed by `policy_ids` therefore cannot widen its own policy. A condition value may name [`${iam:ActorId}`](./iam.md#policy-variables).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies)
- [Permissions in Practice - Step 5 (Attach policies to users)](/docs/tutorials/permissions#step-5--attach-policies-to-users)
- [Agent SOAT Tools and Preset Parameters - Step 5 (Create user alice with a restricted policy)](/docs/tutorials/agent-soat-tools#step-5--create-user-alice-with-a-restricted-policy)

## Data Model

| Field         | Type   | Description                                |
| ------------- | ------ | ------------------------------------------ |
| `id`          | string | Public identifier prefixed with `pol_`     |
| `project_id`  | string | Owning project; `null` for a global policy |
| `name`        | string | Human-readable policy name                 |
| `description` | string | Optional description                       |
| `document`    | object | Policy document (see [IAM](./iam.md))      |
| `created_at`  | string | ISO 8601 creation timestamp                |
| `updated_at`  | string | ISO 8601 last-updated timestamp            |

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

### Project and Global Policies

|                            | Project policy (`project_id` set)                                  | Global policy (`project_id` `null`)          |
| -------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Created by                 | a caller holding `policies:CreatePolicy` in the project            | the unrestricted admin only                  |
| Read, edit, delete         | `policies:*` in the project                                        | the unrestricted admin only                  |
| `Allow` resources          | only `srn:<project_id>:<type>:<id>` of its own project, else `400` | any                                          |
| Carried in `policy_ids` by | agents, triggers and webhooks of the same project                  | agents, triggers and webhooks of any project |

- `POST` with `project_id`, or with a project-scoped API key (its project is the default), creates a project policy; without either, a global one. The project never changes; deleting the project deletes its policies.
- A `policy` resource in a [formation](./formations.md) is a project policy of the formation's project.
- An `Allow` with no `resource`, `*`, `srn:*:…`, a project glob, or another project's SRN is refused (`400 VALIDATION_FAILED`, `meta.details`). A `Deny` may name anything.
- Listing returns only the projects' policies the caller may list; the unrestricted admin also sees global ones.
- A project policy read outside the caller's reach is `404`, and so is a `GET`, `PUT` or `DELETE` of an id that names no policy; a global policy is `403` to anyone but the unrestricted admin.
- `policy_ids` naming another project's policy is `400 POLICY_OUTSIDE_PROJECT` (`meta.policy_id`). Attaching or editing an attached policy still needs a writer who holds its grants (`403 POLICY_GRANT_NOT_HELD`).

### Attaching Policies to Users

All of a user's policies are evaluated together. Attaching **replaces** the full list. See [Permissions in Practice - Step 5 (Attach policies to users)](/docs/tutorials/permissions#step-5--attach-policies-to-users), and the [Attach policies to a user](#attach-policies-to-a-user) example below.

### Attaching Policies to API Keys

With key policies, effective permissions are the **intersection** of the user's and the key's; a key never exceeds its user. Without them, the key inherits the user's permissions. See [API Keys](./api-keys.md).

### SRN Scoping

Resource SRNs carry the full project identifier:

```json
{ "resource": ["srn:proj_ABC:document:*"] }
```

In a global policy, `srn:*:*:*` grants all projects (admin-level) and a project-specific SRN restricts it to one project without scoping the API key. A project policy names only its own project.

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

### Create a project policy

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-policy \
  --project-id proj_ABC \
  --name "Project Readers" \
  --document '{"statement":[{"effect":"Allow","action":["documents:GetDocument"],"resource":["srn:proj_ABC:document:*"]}]}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.policies.createPolicy({
  body: {
    project_id: 'proj_ABC',
    name: 'Project Readers',
    document: {
      statement: [
        {
          effect: 'Allow',
          action: ['documents:GetDocument'],
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
  -H "Authorization: Bearer <project-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Project Readers",
    "document": {
      "statement": [{
        "effect": "Allow",
        "action": ["documents:GetDocument"],
        "resource": ["srn:proj_ABC:document:*"]
      }]
    }
  }'
```

</TabItem>
</Tabs>

### List a project's policies

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-policies --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.policies.listPolicies({
  query: { project_id: 'proj_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/policies?project_id=proj_ABC" \
  -H "Authorization: Bearer <project-key>"
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
