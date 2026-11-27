---
description: 'Groups of projects: an authorization scope above the project, with its own resources and attached policies.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Groups

A group holds projects. Its attached policies cap every check in it, and its owner holds the group's own resources: its projects, keys, members, usage and billing reads. Groups carry no budget, quota or count.

## Overview

The unrestricted admin creates a group for an owner (a [user](./users.md)) and moves projects in and out of it. The owner, or a key acting for it, takes the [group actions](#group-actions) on the group, each checked on the group's SRN through the same policies as every other check, [`POST /api/v1/iam/check`](/docs/api/iam/check-iam-permission) included.

> See the [Permissions Reference](../permissions.md) for the IAM action strings of the group routes.

## Data Model

| Field              | Type     | Description                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `id`               | string   | Public identifier prefixed with `grp_`                                      |
| `name`             | string   | The group's name                                                            |
| `owner_id`         | string   | The user holding the group's own resources                                  |
| `policy_ids`       | string[] | Policies the owner attached: global ones, or policies of a project in it     |
| `fixed_policy_ids` | string[] | Global policies the unrestricted admin attached; only it writes them        |
| `project_ids`      | string[] | The projects in the group                                                   |
| `created_at`       | string   | ISO 8601 creation timestamp                                                 |
| `updated_at`       | string   | ISO 8601 last-updated timestamp                                             |

## Key Concepts

### The group's SRN

A group's own resources are `srn:group:<group_id>:<type>/<id>`, the type one of `project`, `api_key`, `member`, `usage`, `balance` and `statement`, the id `*` for a create or a list. The whole group is `srn:group:<group_id>:*`. A project's resources keep their own SRN, `srn:<project_id>:<type>:<id>`.

### Group actions

Each is checked on its group's SRN alone; `iam/check` refuses one on a project SRN, and a project action on a group SRN, with `400`.

| Action                                                                                    | Type        |
| ----------------------------------------------------------------------------------------- | ----------- |
| `groups:GetGroup`, `groups:UpdateGroup`                                                   | whole group |
| `groups:CreateProject`, `groups:ArchiveProject`                                           | `project`   |
| `groups:CreateApiKey`, `groups:RotateApiKey`, `groups:RevokeApiKey`                       | `api_key`   |
| `groups:ListMembers`, `groups:AddMember`, `groups:UpdateMember`, `groups:RemoveMember`    | `member`    |
| `groups:GetUsage`                                                                         | `usage`     |
| `groups:GetBalance`                                                                       | `balance`   |
| `groups:ListStatements`                                                                   | `statement` |

The runtime serves `GetGroup`, `UpdateGroup`, `CreateProject` ([`POST /api/v1/groups/{group_id}/projects`](/docs/api/groups/create-group-project)), `CreateApiKey` and `RevokeApiKey` (a key's `group_id`); a service fronting the runtime asks `iam/check` for the rest.

### Who holds what

- The **owner** holds every group action on its group, `groups:*` on `srn:group:<group_id>:*`, never on its projects: a project grants as it does outside a group.
- The group's policies, `fixed_policy_ids` and `policy_ids` together, are one more set every check in the group must satisfy, on its projects and on its own resources. A group with none caps nothing. They cap everyone but the unrestricted admin, so a `Deny` in them holds against every credential acting in the group; `meta.denied_by` names `{ "type": "group", "id": "<group_id>" }`.
- **Attaching** goes through the grant check: the writer holds every grant the policy carries ([`POLICY_GRANT_NOT_HELD`](../error-codes.md#policy_grant_not_held)), as for any carrier; a `Deny`-only policy carries none. A project policy outside the group is `400 POLICY_OUTSIDE_PROJECT`.
- **Fixed policies** are global and written only by the unrestricted admin: the owner can neither detach one ([`PATCH /api/v1/groups/{group_id}`](/docs/api/groups/update-group) with `fixed_policy_ids` is `403`) nor edit it (a global policy is the admin's). A policy a group names cannot be deleted (`409 POLICY_HAS_DEPENDENTS`, `meta.groups`).

### Group keys

A key created with `group_id` in place of `project_id` acts on its group's own resources and on the projects in it, nowhere else, read live as projects join and leave. Creating one needs `groups:CreateApiKey` on `srn:group:<group_id>:api_key/*`; deleting one, `groups:RevokeApiKey` on its own SRN. A group key narrowed by `policy_ids` reaches no group action they deny. It lists and manages only keys of its group or of a project in it.

An [IAM token](./iam.md#iam-tokens) minted from a group key names `project_id`, a project of the group, and acts in that project alone, as one minted from a project key.

### Projects

[`POST /api/v1/groups/{group_id}/projects`](/docs/api/groups/create-group-project) creates a project in the group. The unrestricted admin moves an existing project in with [`PUT /api/v1/groups/{group_id}/projects/{project_id}`](/docs/api/groups/add-group-project) and out with [`DELETE /api/v1/groups/{group_id}/projects/{project_id}`](/docs/api/groups/remove-group-project). A project is in one group at most. A group holding projects is not deleted (`409 GROUP_HAS_PROJECTS`).

## Examples

### Create a group

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-group \
  --name "Acme" \
  --owner-id user_V1StGXR8Z5jdHi6B \
  --fixed-policy-ids pol_V1StGXR8Z5jdHi6C
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: '<admin-jwt>',
});

const { data, error } = await soat.groups.createGroup({
  body: {
    name: 'Acme',
    owner_id: 'user_V1StGXR8Z5jdHi6B',
    fixed_policy_ids: ['pol_V1StGXR8Z5jdHi6C'],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/groups \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme",
    "owner_id": "user_V1StGXR8Z5jdHi6B",
    "fixed_policy_ids": ["pol_V1StGXR8Z5jdHi6C"]
  }'
```

</TabItem>
</Tabs>

### Check a group action

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat check-iam-permission \
  --action groups:CreateApiKey \
  --resource "srn:group:grp_V1StGXR8Z5jdHi6B:api_key/*"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.iam.checkIamPermission({
  body: {
    action: 'groups:CreateApiKey',
    resource: 'srn:group:grp_V1StGXR8Z5jdHi6B:api_key/*',
  },
});
if (error) throw new Error(JSON.stringify(error));
// data.allowed
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/iam/check \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "action": "groups:CreateApiKey",
    "resource": "srn:group:grp_V1StGXR8Z5jdHi6B:api_key/*"
  }'
```

</TabItem>
</Tabs>
