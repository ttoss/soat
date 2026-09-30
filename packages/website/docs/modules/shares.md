---
description: 'Grant another project actions on one of your tools or agents, with per-consumer acceptance, suspension and revocation in SOAT.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Shares

Grant another project actions on one of your project's tools or agents.

## Overview

Every resource belongs to one project. A **share** is the publisher project's record that another project — or any project — may invoke one of its resources with a fixed set of actions. It grants nothing until the grantee writes an **acceptance**, so the publisher always has one row per consumer to list and revoke.

A share is the record and its lifecycle. What a share lets a grantee reference and invoke is described on the pages of the resource types it names.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Share

| Field          | Type           | Description                                                                              |
| -------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `id`           | string         | Public identifier (e.g. `shr_…`)                                                         |
| `project_id`   | string         | The publishing project                                                                   |
| `resource`     | string         | SRN of the shared resource, `srn:<project_id>:<type>:<id>`                               |
| `actions`      | string[]       | The actions granted                                                                      |
| `grantee`      | string         | The project the share is offered to, or `*`                                              |
| `suspended_at` | string \| null | Set while the share is suspended                                                         |
| `revoked_at`   | string \| null | Set once the publisher revoked the share                                                 |
| `acceptance`   | object \| null | On a grantee's read only: that project's acceptance                                      |
| `projection`   | object \| null | On a single-share read only: what a grantee sees of the resource; `null` once it is gone |
| `created_at`   | string         | ISO 8601 creation timestamp                                                              |
| `updated_at`   | string         | ISO 8601 last-updated timestamp                                                          |

### ShareAcceptance

| Field         | Type           | Description                          |
| ------------- | -------------- | ------------------------------------ |
| `id`          | string         | Public identifier (e.g. `shr_acc_…`) |
| `share_id`    | string         | The accepted share                   |
| `project_id`  | string         | The accepting project                |
| `status`      | string         | `active` or `revoked`                |
| `revoked_by`  | string \| null | `publisher` or `consumer`            |
| `accepted_at` | string         | When the project last accepted       |
| `revoked_at`  | string \| null | When the acceptance was revoked      |
| `created_at`  | string         | ISO 8601 creation timestamp          |
| `updated_at`  | string         | ISO 8601 last-updated timestamp      |

## Key Concepts

### Shareable types

The types a share may name, and what it may grant on each, are one fixed table. An action outside it is `400 VALIDATION_FAILED`, and no write action is grantable.

| Type    | Grantable actions              | `projection`                                                                                    |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `tool`  | `tools:CallTool`               | `id`, `name`, `description`, `parameters` — never `execute`, `mcp`, headers or `output_mapping` |
| `agent` | `agents:CreateAgentGeneration` | `id`, `name` — never instructions, provider or tools                                            |

`resource` names one concrete resource in the publishing project. There is no wildcard: `srn:proj_P:tool:*` would grant tools that do not exist yet, so ten tools are ten shares. A resource in another project is `400 VALIDATION_FAILED`, and one that does not exist is `400 TOOL_NOT_FOUND` / `400 AGENT_NOT_FOUND`.

### Grantee and acceptance

`grantee` is a project id, or `*` for a **public share**. A public share is an offer: each consuming project still accepts it, so the publisher can list and revoke consumers one by one. `*` is `403 PUBLIC_SHARES_DISABLED` unless the deployment sets `SHARES_ALLOW_PUBLIC=true`.

[`POST /api/v1/shares/{share_id}/accept`](/docs/api/shares/accept-share) is idempotent. A grantee reads a share addressed to it, or a public one by id, before accepting. There is no cross-project listing of offers: [`GET /api/v1/shares`](/docs/api/shares/list-shares) with `role=grantee` lists what is addressed to the project and the public shares it already accepted. Discovering public shares is the job of the platform built on SOAT.

### Which side a call acts for

The publisher authorizes against `srn:<publisher>:share:<id>`, a grantee against `srn:<grantee>:share:<id>`. The acting project is the one the request names in `project_id`, else the one a scoped credential is bound to. With neither, or when it is the publisher, the call is the publisher's. So a key scoped to the grantee project needs no `project_id`, and a share not addressed to the acting project reads as `404`.

[`GET /api/v1/shares/{share_id}`](/docs/api/shares/get-share) and [`POST /api/v1/shares/{share_id}/revoke`](/docs/api/shares/revoke-share) serve both sides. Suspend, resume, delete and the acceptance routes are the publisher's.

### Suspend and revoke

|                           | Suspend                                                                       | Revoke                           |
| ------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| Reversible                | Yes: [`POST /api/v1/shares/{share_id}/resume`](/docs/api/shares/resume-share) | No                               |
| Acceptances               | Kept, and denied while suspended                                              | Marked `revoked`                 |
| Consumer re-accepts after | Never needed                                                                  | Refused with `403 SHARE_REVOKED` |

Revoke applies to one acceptance or to the whole share:

- [`POST /api/v1/shares/{share_id}/revoke`](/docs/api/shares/revoke-share) as the publisher revokes the whole share and every acceptance.
- The same route as a grantee revokes that project's own acceptance (`revoked_by: consumer`). The project may accept again later.
- [`POST /api/v1/shares/{share_id}/acceptances/{acceptance_id}/revoke`](/docs/api/shares/revoke-share-acceptance) is the publisher cutting one consumer (`revoked_by: publisher`). That project's next accept is `403 SHARE_REVOKED` until the publisher deletes the acceptance with [`DELETE /api/v1/shares/{share_id}/acceptances/{acceptance_id}`](/docs/api/shares/delete-share-acceptance).

Accepting a suspended share records the acceptance, which grants nothing until the share is resumed.

### Consumers are told

Suspend, resume and every publisher-side revoke write a `share_suspended`, `share_resumed` or `share_revoked` entry in the [activity](./activity.md) feed of each affected consumer project. `ref_id` is the share, and `detail` carries `share_id`, `resource` and `publisher_project_id`. Deleting a share, or an active acceptance, writes `share_revoked` too. A consumer revoking its own acceptance writes nothing.

### Accepted shares are dependents

[`DELETE /api/v1/tools/{tool_id}`](/docs/api/tools/delete-tool) answers `409 TOOL_HAS_DEPENDENTS` and [`DELETE /api/v1/agents/{agent_id}`](/docs/api/agents/delete-agent) answers `409 AGENT_HAS_DEPENDENTS` while another project has an active acceptance of a live share, with `meta.accepted_share_count`. `force=true` revokes the shares, then deletes. Any delete of a shared resource revokes its remaining shares, accepted or not.

Deleting a consumer project removes its acceptances; deleting the publisher project with `force=true` removes its shares.

## Configuration

| Environment Variable  | Required | Description                                   |
| --------------------- | -------- | --------------------------------------------- |
| `SHARES_ALLOW_PUBLIC` | No       | `true` allows `grantee: "*"`. Off by default. |

## Examples

### Share a tool with another project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-share \
  --project-id proj_P \
  --resource "srn:proj_P:tool:tool_OCR" \
  --actions '["tools:CallTool"]' \
  --grantee proj_Q
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.shares.createShare({
  body: {
    project_id: 'proj_P',
    resource: 'srn:proj_P:tool:tool_OCR',
    actions: ['tools:CallTool'],
    grantee: 'proj_Q',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/shares \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_P", "resource": "srn:proj_P:tool:tool_OCR", "actions": ["tools:CallTool"], "grantee": "proj_Q"}'
```

</TabItem>
</Tabs>

### Accept it as the grantee

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat accept-share --share-id shr_ABC --project-id proj_Q
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.shares.acceptShare({
  path: { share_id: 'shr_ABC' },
  body: { project_id: 'proj_Q' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/shares/shr_ABC/accept \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_Q"}'
```

</TabItem>
</Tabs>

### Cut one consumer

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-share-acceptances --share-id shr_ABC --status active
soat revoke-share-acceptance --share-id shr_ABC --acceptance-id shr_acc_XYZ
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: acceptances } = await soat.shares.listShareAcceptances({
  path: { share_id: 'shr_ABC' },
  query: { status: 'active' },
});

const { data, error } = await soat.shares.revokeShareAcceptance({
  path: { share_id: 'shr_ABC', acceptance_id: 'shr_acc_XYZ' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/shares/shr_ABC/acceptances?status=active" \
  -H "Authorization: Bearer <token>"

curl -X POST https://api.example.com/api/v1/shares/shr_ABC/acceptances/shr_acc_XYZ/revoke \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
