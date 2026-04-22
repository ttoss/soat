---
sidebar_position: 6
---

# Actors

The Actors module represents entities — people, bots, or other participants — that interact within a project. A common use case is storing external contacts such as WhatsApp numbers, where `externalId` holds the phone number and correlates the actor with a record in the external system.

## Overview

An Actor belongs to a project and has a display name, an optional type, an optional `externalId`, and optional links to an [Agent](./agents.md) or [Chat](./chats.md). Actors are identified by a public `id` prefixed with `act_`. The internal database primary key is never returned.

The module covers:

- **Identity** — display name, type, and external correlation via `externalId`
- **Idempotent creation** — `POST /actors` with `externalId` uses find-or-create semantics
- **Agent/Chat linking** — an Actor can be bound to an Agent or a Chat for AI interactions
- **Instructions** — per-actor system prompt overrides composed into generate calls
- **Tags** — key-value metadata enabling attribute-based access control via IAM conditions

## Data Model

| Field          | Type           | Required | Description                                                                                    |
| -------------- | -------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `id`           | string         | —        | Public identifier prefixed with `act_`                                                         |
| `projectId`    | string         | —        | Public ID of the owning project (`proj_` prefix)                                               |
| `name`         | string         | Yes      | Display name of the actor                                                                      |
| `type`         | string         | No       | Free-form actor type (e.g. `customer`, `agent`)                                                |
| `externalId`   | string         | No       | External identifier (e.g. WhatsApp phone number). Unique per project; `null` is never unique   |
| `instructions` | string \| null | No       | Persona-specific instructions composed into the effective system prompt for generate calls     |
| `agentId`      | string \| null | No       | Public ID of the linked [Agent](./agents.md) (`agt_` prefix). Mutually exclusive with `chatId` |
| `chatId`       | string \| null | No       | Public ID of the linked [Chat](./chats.md) (`chat_` prefix). Mutually exclusive with `agentId` |
| `tags`         | object         | No       | Key-value string pairs used for ABAC conditions (see [Tags](#tags))                            |
| `createdAt`    | string         | —        | ISO 8601 creation timestamp                                                                    |
| `updatedAt`    | string         | —        | ISO 8601 last-updated timestamp                                                                |

## Key Concepts

### externalId and Idempotent Creation

`externalId` is a free-form string for correlating an Actor with a record in an external system (e.g. a WhatsApp phone number, a CRM contact ID). It is enforced unique per project at the database level — two actors in the same project cannot share the same `externalId`. Across different projects the same value is allowed.

`null` / absent `externalId` is never considered a duplicate — PostgreSQL NULL semantics are preserved.

When `externalId` is supplied to `POST /actors`, the endpoint uses **find-or-create** semantics:

- If no actor with that `externalId` exists in the project, a new actor is created and `201 Created` is returned.
- If an actor with that `externalId` already exists, the existing actor is returned as-is with `200 OK`. None of the other request fields (name, type, instructions, etc.) are applied to the existing actor.

This makes actor creation safe to call repeatedly from event-driven pipelines (e.g. a new inbound WhatsApp message) without risk of duplicate actors or errors.

```http
POST /api/v1/actors
Content-Type: application/json

{
  "projectId": "proj_V1StGXR8Z5jdHi6B",
  "name": "Alice",
  "externalId": "+15551234567"
}
```

- First call → `201 Created` with the new actor.
- Subsequent calls with the same `externalId` → `200 OK` with the existing actor.

When `externalId` is **not** supplied, `POST /actors` always creates a new actor and returns `201 Created`.

### Agent and Chat Linking

An Actor can be linked to either an Agent or a Chat — not both simultaneously. These links control which AI backend handles generate calls initiated by or for the actor.

- Set `agentId` to link the actor to a specific Agent.
- Set `chatId` to link the actor to a specific Chat.
- Pass `null` in a `PATCH /actors/:id` request to unlink either field.
- Supplying both `agentId` and `chatId` in the same request returns `400 Bad Request`.

### Instructions

`instructions` is a free-form string injected into the system prompt when an AI generation is scoped to this actor. Use it to encode persona-specific context (tone, name, constraints) that should be consistent across all interactions with the actor.

Pass `null` to `PATCH /actors/:id` to clear the instructions.

### Filtering

`GET /actors` supports the following query parameters for filtering:

| Parameter    | Description                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| `projectId`  | Limit results to a specific project (required for JWT callers in most cases) |
| `externalId` | Exact match — use to resolve an external identifier to an `act_` ID          |
| `name`       | Partial, case-insensitive match against the actor's display name             |
| `type`       | Exact match against the actor's type                                         |
| `limit`      | Maximum number of results to return (default: `50`)                          |
| `offset`     | Number of results to skip for pagination (default: `0`)                      |

The response envelope is:

```json
{
  "data": [
    /* ActorRecord[] */
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

### Project Scope

API keys are automatically scoped to a single project — `projectId` is inferred from the key and must not be supplied in the request body. JWT callers must supply `projectId` explicitly for write operations.

## Tags

Tags are key-value string pairs attached to an actor. They enable attribute-based access control (ABAC) via IAM condition keys (see [IAM](iam.md#tags)).

```json
{
  "tags": {
    "channel": "whatsapp",
    "tier": "premium"
  }
}
```

Tags can be managed via the dedicated tag sub-endpoints:

| Method  | Endpoint                  | Description                                             |
| ------- | ------------------------- | ------------------------------------------------------- |
| `GET`   | `/api/v1/actors/:id/tags` | Return the actor's current tags                         |
| `PUT`   | `/api/v1/actors/:id/tags` | Replace all tags (any tags not in the body are removed) |
| `PATCH` | `/api/v1/actors/:id/tags` | Merge tags (existing tags not in the body are kept)     |

All tag endpoints require `actors:UpdateActor` permission.

## SOAT Resource Names

Actors use the `actor` resource type in SRNs:

```
soat:<projectId>:actor:<actorId>
```

Example: `soat:proj_ABC:actor:act_123`

Use SRN patterns in policy `resource` fields to scope permissions to specific actors or all actors in a project:

```json
{
  "effect": "Allow",
  "action": ["actors:GetActor", "actors:ListActors"],
  "resource": ["soat:proj_ABC:actor:*"]
}
```

## Permissions

Actor operations are governed by per-project policies. Grant the following permissions:

| Action          | Permission           | REST Endpoint               | MCP Tool       |
| --------------- | -------------------- | --------------------------- | -------------- |
| List actors     | `actors:ListActors`  | `GET /api/v1/actors`        | `list-actors`  |
| Get actor by ID | `actors:GetActor`    | `GET /api/v1/actors/:id`    | `get-actor`    |
| Create actor    | `actors:CreateActor` | `POST /api/v1/actors`       | `create-actor` |
| Update actor    | `actors:UpdateActor` | `PATCH /api/v1/actors/:id`  | `update-actor` |
| Delete actor    | `actors:DeleteActor` | `DELETE /api/v1/actors/:id` | `delete-actor` |

## Examples

### Idempotent actor upsert

Safe to call on every inbound message — creates the actor on first contact, returns the existing record thereafter:

```http
POST /api/v1/actors
Authorization: Bearer <project-key>
Content-Type: application/json

{
  "name": "Bob",
  "externalId": "+15559876543",
  "type": "customer"
}
```

### Allow a user to manage all actors in a project

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["actors:*"],
      "resource": ["soat:proj_ABC:actor:*"]
    }
  ]
}
```

### Restrict access to actors tagged with a specific channel

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["actors:GetActor", "actors:ListActors"],
      "resource": ["soat:proj_ABC:actor:*"],
      "condition": {
        "StringEquals": {
          "soat:ResourceTag/channel": "whatsapp"
        }
      }
    }
  ]
}
```
