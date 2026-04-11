# PRD: Actors & Conversations

**Status**: In Development  
**Branch**: `feat-files`  
**Date**: April 10, 2026

---

## Overview

This document describes the design and implementation of two new modules — **Actors** and **Conversations** — added to the Soat platform. These modules allow projects to model participants and their ordered interactions with documents stored in the system.

---

## Problem Statement

Projects that use Soat to manage documents often represent real-world conversations — support tickets, AI chat sessions, interview transcripts, onboarding flows — but the platform had no way to:

1. Represent the **participant** (human, AI agent, service) who drives a conversation.
2. Group and **sequence documents** that belong to a single conversational exchange.
3. Track whether a conversation is **active or concluded**.

Without these primitives, consumers must maintain that structure in their own databases, losing the ability to query, filter, and act on conversations server-side.

---

## Goals

- Introduce a first-class `Actor` entity scoped to a project.
- Introduce a first-class `Conversation` entity that ties together an actor, a project, and an ordered sequence of documents.
- Expose full CRUD over both entities via the REST API, MCP tools, and documentation.
- Fit naturally into the existing auth model (project policies, `isAllowed` permission checks).

---

## Non-Goals

- Real-time messaging or WebSocket streaming.
- Conversation history versioning or audit trails.
- Multi-actor conversations (a conversation has exactly one actor in this version).
- Document content modification through conversation endpoints.

---

## Data Model

### Actor

Represents a participant — a human user, an AI agent, or any named entity that can own a conversation.

| Field       | Type             | Notes                                         |
| ----------- | ---------------- | --------------------------------------------- |
| `id`        | `string`         | Public ID, prefixed `act_`                    |
| `projectId` | `string`         | Public ID of the owning project               |
| `name`      | `string`         | Display name (required)                       |
| `type`      | `string \| null` | Optional label, e.g. `human`, `ai`, `service` |
| `createdAt` | `string`         | ISO 8601                                      |
| `updatedAt` | `string`         | ISO 8601                                      |

**Database table**: `actors`  
**Cascade**: deleted when parent project is deleted (`onDelete: CASCADE`).

---

### Conversation

Represents a single conversational session, owned by one actor, containing an ordered list of documents.

| Field       | Type                 | Notes                                             |
| ----------- | -------------------- | ------------------------------------------------- |
| `id`        | `string`             | Public ID, prefixed `conv_`                       |
| `projectId` | `string`             | Public ID of the owning project                   |
| `actorId`   | `string`             | Public ID of the actor who owns this conversation |
| `status`    | `"open" \| "closed"` | `open` by default                                 |
| `createdAt` | `string`             | ISO 8601                                          |
| `updatedAt` | `string`             | ISO 8601                                          |

**Database table**: `conversations`  
**Cascade**: deleted when parent project or actor is deleted.

---

### ConversationDocument (junction)

Associates a document with a conversation at a specific position in the sequence.

| Field            | Type     | Notes                                                |
| ---------------- | -------- | ---------------------------------------------------- |
| `conversationId` | `number` | Internal FK to `conversations`                       |
| `documentId`     | `number` | Internal FK to `documents`                           |
| `position`       | `number` | Zero-based integer; auto-incremented if not provided |

**Database table**: `conversation_documents`  
**Unique constraint**: `(conversation_id, document_id)` — a document can appear only once per conversation.  
**Ordering**: queries return entries sorted by `position ASC`.

---

## Permission Model

Both modules integrate with the existing project policy system. The following action strings are checked via `ctx.authUser.isAllowed(projectId, action)`:

| Action                             | Endpoint                                     |
| ---------------------------------- | -------------------------------------------- |
| `actors:ListActors`                | `GET /actors`                                |
| `actors:GetActor`                  | `GET /actors/:id`                            |
| `actors:CreateActor`               | `POST /actors`                               |
| `actors:DeleteActor`               | `DELETE /actors/:id`                         |
| `conversations:ListConversations`  | `GET /conversations`                         |
| `conversations:GetConversation`    | `GET /conversations/:id`                     |
| `conversations:GetConversation`    | `GET /conversations/:id/documents`           |
| `conversations:CreateConversation` | `POST /conversations`                        |
| `conversations:UpdateConversation` | `PATCH /conversations/:id`                   |
| `conversations:UpdateConversation` | `POST /conversations/:id/documents`          |
| `conversations:UpdateConversation` | `DELETE /conversations/:id/documents/:docId` |
| `conversations:DeleteConversation` | `DELETE /conversations/:id`                  |

---

## REST API

### Actors

```
GET    /actors?projectId=<id>          List actors
GET    /actors/:id                     Get actor
POST   /actors                         Create actor
DELETE /actors/:id                     Delete actor
```

**POST /actors** body:

```json
{
  "projectId": "proj_...",
  "name": "Support Bot",
  "type": "ai"
}
```

---

### Conversations

```
GET    /conversations?projectId=<id>           List conversations
GET    /conversations/:id                       Get conversation
POST   /conversations                           Create conversation
PATCH  /conversations/:id                       Update status
DELETE /conversations/:id                       Delete conversation
GET    /conversations/:id/documents             List documents in order
POST   /conversations/:id/documents             Add document to conversation
DELETE /conversations/:id/documents/:documentId Remove document
```

**POST /conversations** body:

```json
{
  "projectId": "proj_...",
  "actorId": "act_...",
  "status": "open"
}
```

**PATCH /conversations/:id** body:

```json
{ "status": "closed" }
```

**POST /conversations/:id/documents** body:

```json
{
  "documentId": "doc_...",
  "position": 2
}
```

If `position` is omitted, the document is appended at `MAX(position) + 1` (or position `0` if the conversation is empty).

---

## MCP Tools

All operations are also exposed as MCP tools for AI agent consumption:

| Tool name                      | Description                                |
| ------------------------------ | ------------------------------------------ |
| `list-actors`                  | List actors in a project                   |
| `get-actor`                    | Get actor by ID                            |
| `create-actor`                 | Create an actor                            |
| `delete-actor`                 | Delete an actor                            |
| `list-conversations`           | List conversations in a project            |
| `get-conversation`             | Get conversation by ID                     |
| `create-conversation`          | Create a conversation                      |
| `update-conversation-status`   | Set status to `open` or `closed`           |
| `delete-conversation`          | Delete a conversation                      |
| `list-conversation-documents`  | List documents in a conversation (ordered) |
| `add-conversation-document`    | Add a document at a given position         |
| `remove-conversation-document` | Remove a document from a conversation      |

---

## Implementation Architecture

```
packages/postgresdb/src/models/
  Actor.ts                   ← DB model, publicId: act_
  Conversation.ts            ← DB model, publicId: conv_
  ConversationDocument.ts    ← Junction table model

packages/server/src/lib/
  actors.ts                  ← listActors, getActor, createActor, deleteActor
  conversations.ts           ← listConversations, getConversation, createConversation,
                               updateConversationStatus, deleteConversation,
                               listConversationDocuments, addDocumentToConversation,
                               removeDocumentFromConversation

packages/server/src/rest/v1/
  actors.ts                  ← REST routes registered in index.ts
  conversations.ts           ← REST routes registered in index.ts

packages/server/src/mcp/tools/
  actors.ts                  ← MCP tools registered in index.ts
  conversations.ts           ← MCP tools registered in index.ts
```

---

## Remaining Work

- [ ] OpenAPI YAML component schemas (`ActorRecord`, `ConversationRecord`, `ConversationDocumentRecord`) in `src/rest/openapi/v1/`
- [ ] Module docs page at `packages/website/docs/modules/actors.md` and `conversations.md`
- [ ] Unit tests at `packages/server/tests/unit/tests/actors.test.ts` and `conversations.test.ts`
- [ ] Database migration / sync for `actors`, `conversations`, `conversation_documents` tables

---

## Open Questions

1. **Multi-actor conversations** — should a future version support multiple actors per conversation (e.g. a thread between a human and an AI)?
2. **Position gaps** — if a document is removed from the middle, positions are not re-indexed. Should a reorder endpoint be added?
3. **Conversation filters** — should `GET /conversations` support filtering by `status` or `actorId`?
