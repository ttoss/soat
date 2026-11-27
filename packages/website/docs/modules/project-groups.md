---
description: 'Project groups: an authorization scope above the project, with its own resources and attached policies.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Project groups

A project group holds projects. Its attached policies cap every check in it, and its owner holds the project group's own resources: its projects, keys, members, usage and billing reads. Project groups carry no budget, quota or count.

## Overview

The unrestricted admin creates a project group for an owner (a [user](./users.md)) and moves projects in and out of it. The owner, or a key acting for it, takes the [project group actions](#project-group-actions) on the project group, each checked on the project group's SRN through the same policies as every other check, [`POST /api/v1/iam/check`](/docs/api/iam/check-iam-permission) included.

> See the [Permissions Reference](../permissions.md) for the IAM action strings of the project group routes.

## Data Model

| Field              | Type     | Description                                                              |
| ------------------ | -------- | ------------------------------------------------------------------------ |
| `id`               | string   | Public identifier prefixed with `pgrp_`                                  |
| `name`             | string   | The project group's name                                                 |
| `owner_id`         | string   | The user holding the project group's own resources                       |
| `policy_ids`       | string[] | Policies the owner attached: global ones, or policies of a project in it |
| `fixed_policy_ids` | string[] | Global policies the unrestricted admin attached; only it writes them     |
| `project_ids`      | string[] | The projects in the project group                                        |
| `created_at`       | string   | ISO 8601 creation timestamp                                              |
| `updated_at`       | string   | ISO 8601 last-updated timestamp                                          |

## Key Concepts

### The project group's SRN

A project group's own resources are `srn:project-group:<project_group_id>:<type>/<id>`, the type one of `project`, `api_key`, `member`, `usage`, `balance`, `statement` and the types a deployment [registers](#registered-project-group-actions), the id `*` for a create or a list. The whole project group is `srn:project-group:<project_group_id>:*`. A project's resources keep their own SRN, `srn:<project_id>:<type>:<id>`.

### Project group actions

Each is checked on its project group's SRN alone; `iam/check` refuses one on a project SRN, and a project action on a project group SRN, with `400`.

| Action                                                                                                                 | Type                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `project-groups:GetProjectGroup`, `project-groups:UpdateProjectGroup`                                                  | whole project group |
| `project-groups:CreateProject`, `project-groups:ArchiveProject`                                                        | `project`           |
| `project-groups:CreateApiKey`, `project-groups:RotateApiKey`, `project-groups:RevokeApiKey`                            | `api_key`           |
| `project-groups:ListMembers`, `project-groups:AddMember`, `project-groups:UpdateMember`, `project-groups:RemoveMember` | `member`            |
| `project-groups:GetUsage`                                                                                              | `usage`             |
| `project-groups:GetBalance`                                                                                            | `balance`           |
| `project-groups:ListStatements`                                                                                        | `statement`         |

The runtime serves `GetProjectGroup`, `UpdateProjectGroup`, `CreateProject` ([`POST /api/v1/project-groups/{project_group_id}/projects`](/docs/api/project-groups/create-project-group-project)), `CreateApiKey` and `RevokeApiKey` (a key's `project_group_id`); a service fronting the runtime asks `iam/check` for the rest.

### Registered project group actions

A deployment fronting the runtime registers project group actions of its own in `project_group_actions` of a module in its [IAM registrations](./iam.md#deployment-registered-actions), each with the types it is checked on (`billing:TopUp` on `srn:project-group:<project_group_id>:top_up/*`). They are project group actions like the built-in ones: policies name them, `iam/check` answers them on a project group's SRN alone, the owner holds them, and the project group's policies and a key's `policy_ids` narrow them.

### Who holds what

- The **owner** holds every project group action on its project group, `project-groups:*` and every [registered](#registered-project-group-actions) one on `srn:project-group:<project_group_id>:*`, never on its projects: a project grants as it does outside a project group.
- The project group's policies, `fixed_policy_ids` and `policy_ids` together, are one more set every check in the project group must satisfy, on its projects and on its own resources. A project group with none caps nothing. They cap everyone but the unrestricted admin, so a `Deny` in them holds against every credential acting in the project group; `meta.denied_by` names `{ "type": "project_group", "id": "<project_group_id>" }`.
- **Attaching** goes through the grant check: the writer holds every grant the policy carries ([`POLICY_GRANT_NOT_HELD`](../error-codes.md#policy_grant_not_held)), as for any carrier; a `Deny`-only policy carries none. A project policy outside the project group is `400 POLICY_OUTSIDE_PROJECT`.
- **Fixed policies** are global and written only by the unrestricted admin: the owner can neither detach one ([`PATCH /api/v1/project-groups/{project_group_id}`](/docs/api/project-groups/update-project-group) with `fixed_policy_ids` is `403`) nor edit it (a global policy is the admin's). A policy a project group names cannot be deleted (`409 POLICY_HAS_DEPENDENTS`, `meta.project_groups`).

### Project group keys

A key created with `project_group_id` in place of `project_id` acts on its project group's own resources and on the projects in it, nowhere else, read live as projects join and leave. Creating one needs `project-groups:CreateApiKey` on `srn:project-group:<project_group_id>:api_key/*`; deleting one, `project-groups:RevokeApiKey` on its own SRN. A project group key narrowed by `policy_ids` reaches no project group action they deny. It lists and manages only keys of its project group or of a project in it.

An [IAM token](./iam.md#iam-tokens) minted from a project group key names `project_id`, a project of the project group, and acts in that project alone, as one minted from a project key.

### Projects

[`POST /api/v1/project-groups/{project_group_id}/projects`](/docs/api/project-groups/create-project-group-project) creates a project in the project group. The unrestricted admin moves an existing project in with [`PUT /api/v1/project-groups/{project_group_id}/projects/{project_id}`](/docs/api/project-groups/add-project-group-project) and out with [`DELETE /api/v1/project-groups/{project_group_id}/projects/{project_id}`](/docs/api/project-groups/remove-project-group-project). A project is in one project group at most. A project group holding projects is not deleted (`409 PROJECT_GROUP_HAS_PROJECTS`).

## Examples

### Create a project group

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-project-group \
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

const { data, error } = await soat.projectGroups.createProjectGroup({
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
curl -X POST https://api.example.com/api/v1/project-groups \
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

### Check a project group action

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat check-iam-permission \
  --action project-groups:CreateApiKey \
  --resource "srn:project-group:pgrp_V1StGXR8Z5jdHi6B:api_key/*"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.iam.checkIamPermission({
  body: {
    action: 'project-groups:CreateApiKey',
    resource: 'srn:project-group:pgrp_V1StGXR8Z5jdHi6B:api_key/*',
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
    "action": "project-groups:CreateApiKey",
    "resource": "srn:project-group:pgrp_V1StGXR8Z5jdHi6B:api_key/*"
  }'
```

</TabItem>
</Tabs>
