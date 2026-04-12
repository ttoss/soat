# Conversations Module

The Conversations module represents a series of messages exchanged with an Actor within a project. Conversations group documents (messages) in an ordered sequence, tracking the dialogue between a system and an actor such as a WhatsApp contact.

## Overview

A Conversation belongs to a project and is associated with an Actor. It has a status (`open` or `closed`) and contains an ordered list of messages, where each message is a reference to a Document along with its position in the conversation.

Conversations are identified by an `id` prefixed with `conv_`. The internal database primary key is never returned.

## Data Model

### Conversation

| Field       | Type   | Description                                         |
| ----------- | ------ | --------------------------------------------------- |
| `id`        | string | Public identifier prefixed with `conv_`             |
| `projectId` | string | ID of the owning project                     |
| `actorId`   | string | ID of the Actor this conversation belongs to |
| `status`    | string | Conversation status: `open` or `closed`             |
| `createdAt` | string | ISO 8601 creation timestamp                         |
| `updatedAt` | string | ISO 8601 last-updated timestamp                     |

### Conversation Message

| Field        | Type    | Description                                                          |
| ------------ | ------- | -------------------------------------------------------------------- |
| `documentId` | string  | ID of the Document attached as a message                      |
| `position`   | integer | Zero-based position of the message in the conversation               |
| `content`    | string  | Full text content of the message (read from the underlying document) |

## Key Concepts

### Messages

Messages are ordered references to Documents within a conversation. When adding a message, you can specify an explicit `position`. If omitted, the document is appended at the end (position = MAX + 1). Each document can appear at most once per conversation — adding the same document twice returns `409 Conflict`.

When listing messages, each entry includes the full text `content` of the underlying document.

Removing a message from a conversation also deletes its underlying Document and the associated File on disk, preventing orphaned records.

### Status

A conversation transitions between `open` and `closed`. Use `PATCH /conversations/:id` to update the status. New conversations default to `open`.

### Actor Association

Every conversation is linked to a single Actor. You can filter conversations by `actorId` using the `GET /conversations?actorId=` query parameter to retrieve all conversations for a specific contact.

## Permissions

Conversation operations are governed by per-project policies. Grant the following permissions:

| Action                           | Permission                         | REST Endpoint                               | MCP Tool                      |
| -------------------------------- | ---------------------------------- | ------------------------------------------- | ----------------------------- |
| List conversations               | `conversations:ListConversations`  | `GET /api/v1/conversations`                 | `list-conversations`          |
| Get conversation by ID           | `conversations:GetConversation`    | `GET /api/v1/conversations/:id`             | `get-conversation`            |
| List conversation messages       | `conversations:GetConversation`    | `GET /api/v1/conversations/:id/messages`    | `list-conversation-messages`  |
| List conversation actors         | `conversations:GetConversation`    | `GET /api/v1/conversations/:id/actors`      | `list-conversation-actors`    |
| Create conversation              | `conversations:CreateConversation` | `POST /api/v1/conversations`                | `create-conversation`         |
| Update conversation status       | `conversations:UpdateConversation` | `PATCH /api/v1/conversations/:id`           | `update-conversation`         |
| Add message to conversation      | `conversations:UpdateConversation` | `POST /api/v1/conversations/:id/messages`   | `add-conversation-message`    |
| Remove message from conversation | `conversations:UpdateConversation` | `DELETE /api/v1/conversations/:id/messages` | `remove-conversation-message` |
| Delete conversation              | `conversations:DeleteConversation` | `DELETE /api/v1/conversations/:id`          | `delete-conversation`         |
