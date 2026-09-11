---
description: "The Actors module represents people, bots, and external participants within a SOAT project, correlating them with external systems via external_id."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Actors

Actors are people, bots, or other participants within a project. A common use is external contacts such as WhatsApp numbers, with `external_id` holding the phone number.

## Overview

An Actor belongs to a project and has a display name, an optional `external_id`, and optional links to an [Agent](./agents.md) or [Chat](./chats.md). Actors are identified by a public `id` prefixed with `actor_`. The internal database primary key is never returned.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Cap Spend Per End User - Step 4 (Create an actor per end user)](/docs/tutorials/cap-spend-per-end-user#step-4--create-an-actor-per-end-user)
- [Cap Spend Per End User - Step 5 (Run a turn through a session bound to the actor)](/docs/tutorials/cap-spend-per-end-user#step-5--run-a-turn-through-a-session-bound-to-the-actor)

## Data Model

| Field          | Type           | Required | Description                                                                                                       |
| -------------- | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`           | string         | —        | Public identifier prefixed with `actor_`                                                                          |
| `project_id`   | string         | —        | Public ID of the owning project (`proj_` prefix)                                                                  |
| `name`         | string         | Yes      | Display name of the actor                                                                                         |
| `external_id`  | string         | No       | External identifier (e.g. WhatsApp phone number). Unique per project; `null` is never unique                      |
| `instructions` | string \| null | No       | Persona-specific instructions composed into the effective system prompt for generate calls                        |
| `agent_id`     | string \| null | No       | Public ID of the linked [Agent](./agents.md) (`agent_` prefix). Mutually exclusive with `chat_id`                 |
| `chat_id`      | string \| null | No       | Public ID of the linked [Chat](./chats.md) (`chat_` prefix). Mutually exclusive with `agent_id`                   |
| `tags`         | object         | No       | Key-value string pairs used for ABAC conditions (see [Tags](#tags))                                               |
| `created_at`   | string         | —        | ISO 8601 creation timestamp                                                                                       |
| `updated_at`   | string         | —        | ISO 8601 last-updated timestamp                                                                                   |

## Key Concepts

### external_id and Idempotent Creation

`external_id` correlates an Actor with an external record (WhatsApp number, CRM contact ID). Unique per project at the database level; the same value may recur across projects. `null`/absent is never a duplicate (PostgreSQL NULL semantics).

:::warning[Choose this value knowing it egresses]

Whenever a generation runs in a [session](./sessions.md) bound to this actor, `external_id` is auto-populated into `tool_context` and sent as the `X-Soat-Context-actor_external_id` header to **every** `http` and `mcp` tool the agent calls, including endpoints you do not control.

With third-party endpoints in the tool set, prefer an opaque internal identifier and correlate on your side. See [Tool Context](../advanced/tool-context.md#security).

:::

With `external_id`, [`POST /actors`](/docs/api/actors/create-actor) is **find-or-create**:

- No match: created, `201 Created`.
- Match: the existing actor is returned as-is with `200 OK`; other request fields (name, instructions, etc.) are not applied.

This makes creation safe to repeat from event-driven pipelines (e.g. an inbound WhatsApp message). Without `external_id`, [`POST /actors`](/docs/api/actors/create-actor) always creates and returns `201 Created`.

### Agent and Chat Linking

An Actor links to an Agent or a Chat, not both; the link selects the AI backend for generate calls for the actor.

- `agent_id` links an Agent; `chat_id` a Chat.
- `null` in [`PATCH /actors/:id`](/docs/api/actors/update-actor) unlinks.
- Both in one request: `400 Bad Request`.

### Per-Actor Memory

An actor has no memory field; retrieval scope comes from the agent's `knowledge_config` only. Keep the actor→memory mapping in your application and pass it per call.

Create one [Memory](./memories.md) per end user (keyed by `external_id`, for instance) and name it in the generate body:

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_V1StGXR8Z5jdHi6B"],
    "write_memory_id": "mem_V1StGXR8Z5jdHi6B"
  }
}
```

`memory_ids` is **unioned** with the agent's stored config and `tags` pairs are merged, so a per-actor memory extends the shared scope. Without a mapping table, tag the memory (`tags`, e.g. `{ "actor": "<external_id>" }`) or name it after the `external_id` and look it up with [`GET /memories`](/docs/api/memories/list-memories).

Deleting an actor deletes nothing in any memory.

### Instructions

`instructions` is injected into the system prompt when a generation is scoped to this actor: persona context (tone, name, constraints) consistent across interactions. `null` in [`PATCH /actors/:id`](/docs/api/actors/update-actor) clears it.

### Filtering

[`GET /actors`](/docs/api/actors/list-actors) filters by `project_id`, `external_id` (exact match — use it to resolve an external identifier to an `actor_` ID), and `name` (partial, case-insensitive), with `limit`/`offset` pagination in a `{ data, total, limit, offset }` envelope.

### Project Scope

Project-scoped API keys make `project_id` optional (omitted defaults to the key's project; a different project is `403`); JWT callers must supply it on writes. See [Implicit project id](./api-keys.md#implicit-project-id).

### Tags

Key-value string pairs managed via `tags` or the tag sub-endpoints, matched by `soat:ResourceTag/<key>`. SRN type `actor` (`srn:proj_ABC:actor:actor_123`). See [IAM — Tags](iam.md#tags) and [SRNs](iam.md#soat-resource-names-srns).

## Examples

### Create an actor

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-actor \
  --project-id proj_ABC \
  --name Alice \
  --external-id +15551234567
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

const { data, error } = await soat.actors.createActor({
  body: {
    project_id: 'proj_ABC',
    name: 'Alice',
    external_id: '+15551234567',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/actors \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Alice",
    "external_id": "+15551234567"
  }'
```

</TabItem>
</Tabs>

With `external_id` the call is an idempotent upsert: `201` first, `200` thereafter ([external_id and Idempotent Creation](#external_id-and-idempotent-creation)). Policy examples: [IAM — Examples](iam.md#examples).

### Get an actor

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-actor --actor-id actor_123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.actors.getActor({
  path: { actor_id: 'actor_123' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/actors/actor_123 \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
