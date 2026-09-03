---
description: "The Actors module represents people, bots, and external participants within a SOAT project, correlating them with external systems via external_id."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Actors

The Actors module represents entities — people, bots, or other participants — that interact within a project. A common use case is storing external contacts such as WhatsApp numbers, where `external_id` holds the phone number and correlates the actor with a record in the external system.

## Overview

An Actor belongs to a project and has a display name, an optional `external_id`, and optional links to an [Agent](./agents.md) or [Chat](./chats.md). Actors are identified by a public `id` prefixed with `actor_`. The internal database primary key is never returned.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

The module covers:

- **Identity** — display name and external correlation via `external_id`
- **Idempotent creation** — [`POST /actors`](/docs/api/actors/create-actor) with `external_id` uses find-or-create semantics
- **Agent/Chat linking** — an Actor can be bound to an Agent or a Chat for AI interactions
- **Instructions** — per-actor system prompt overrides composed into generate calls
- **Tags** — key-value metadata enabling attribute-based access control via IAM conditions

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

`external_id` is a free-form string for correlating an Actor with a record in an external system (e.g. a WhatsApp phone number, a CRM contact ID). It is enforced unique per project at the database level — two actors in the same project cannot share the same `external_id`. Across different projects the same value is allowed.

`null` / absent `external_id` is never considered a duplicate — PostgreSQL NULL semantics are preserved.

:::warning[Choose this value knowing it egresses]

`external_id` is not internal-only. Whenever a generation runs in a [session](./sessions.md) bound to this actor, the value is auto-populated into `tool_context` and transmitted as the `X-Soat-Context-actor_external_id` request header to **every** `http` and `mcp` tool the agent calls — including endpoints you do not control.

If the tool set includes third-party endpoints, prefer an opaque internal identifier here (and correlate to the phone number or email on your own side) rather than storing the PII directly. See the [Tool Context reference](../advanced/tool-context.md#security).

:::

When `external_id` is supplied to [`POST /actors`](/docs/api/actors/create-actor), the endpoint uses **find-or-create** semantics:

- If no actor with that `external_id` exists in the project, a new actor is created and `201 Created` is returned.
- If an actor with that `external_id` already exists, the existing actor is returned as-is with `200 OK`. None of the other request fields (name, instructions, etc.) are applied to the existing actor.

This makes actor creation safe to call repeatedly from event-driven pipelines (e.g. a new inbound WhatsApp message). When `external_id` is **not** supplied, [`POST /actors`](/docs/api/actors/create-actor) always creates a new actor and returns `201 Created`.

### Agent and Chat Linking

An Actor can be linked to either an Agent or a Chat — not both simultaneously. These links control which AI backend handles generate calls initiated by or for the actor.

- Set `agent_id` to link the actor to a specific Agent.
- Set `chat_id` to link the actor to a specific Chat.
- Pass `null` in a [`PATCH /actors/:id`](/docs/api/actors/update-actor) request to unlink either field.
- Supplying both `agent_id` and `chat_id` in the same request returns `400 Bad Request`.

### Per-Actor Memory

An actor has no memory field. Retrieval scope for a generation comes from the
agent's `knowledge_config` and nothing else, so the platform never read a link
stored on the actor — keep the actor→memory mapping in your application and pass
it per call.

Create one [Memory](./memories.md) per end user, keyed however your application
already keys them (the actor's `external_id` is the natural choice), then name it
in the generate body:

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_V1StGXR8Z5jdHi6B"],
    "write_memory_id": "mem_V1StGXR8Z5jdHi6B"
  }
}
```

`memory_ids` and `memory_tags` are **unioned** with the agent's stored config, so
a per-actor memory extends the agent's shared scope rather than replacing it. If
you would rather not keep a mapping table, tag the memory (`tags`) or name it
after the `external_id` and look it up with
[`GET /memories`](/docs/api/memories/list-memories).

Memory data outlives the actor record: deleting an actor deletes nothing in any
memory.

### Instructions

`instructions` is a free-form string injected into the system prompt when an AI generation is scoped to this actor. Use it to encode persona-specific context (tone, name, constraints) that should be consistent across all interactions with the actor.

Pass `null` to [`PATCH /actors/:id`](/docs/api/actors/update-actor) to clear the instructions.

### Filtering

[`GET /actors`](/docs/api/actors/list-actors) filters by `project_id`, `external_id` (exact match — use it to resolve an external identifier to an `actor_` ID), and `name` (partial, case-insensitive), with `limit`/`offset` pagination in a `{ data, total, limit, offset }` envelope.

### Project Scope

Project-scoped API keys make `project_id` optional: omit it and the request defaults to the key's project, supply a matching one and it is accepted, and supply a different project's id and the request is rejected with `403`. JWT callers must supply `project_id` explicitly for write operations. See [Implicit project id](./api-keys.md#implicit-project-id) for the full rules.

### Tags

Tags are key-value string pairs attached to an actor, managed via the `tags` field or the tag sub-endpoints, and matched by IAM conditions (`soat:ResourceTag/<key>`). Actors use the `actor` resource type in SRNs (`srn:proj_ABC:actor:actor_123`). See [IAM — Tags](iam.md#tags) and [SRNs](iam.md#soat-resource-names-srns).

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

The same call is an idempotent upsert when `external_id` is set — `201` on first contact, `200` with the existing actor thereafter (see [external_id and Idempotent Creation](#external_id-and-idempotent-creation)). For policy examples scoping access to actors (including tag conditions), see [IAM — Examples](iam.md#examples).

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
