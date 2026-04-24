# PRD: Memory Module

## Overview

The Memory module provides a reusable, project-scoped mechanism for injecting contextual knowledge into agents and chats. A memory is a CRUD entity that defines **what** content to retrieve and **how** to retrieve it. When an agent or chat runs, attached memories are queried and the resulting documents are injected as system messages.

This module resolves two roadmap items:

- **Built-in RAG (P0)** — semantic search over project documents
- **Agent Memory (P2)** — persistent, configurable context for agents

## Key Concepts

### Memory Entity

A memory is a named, project-scoped configuration that describes how to retrieve documents. It is independent of any agent or chat — it can be created, queried, and managed on its own.

| Field         | Type     | Required | Description                                                                    |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `id`          | string   | auto     | Public ID with `mem_` prefix                                                   |
| `name`        | string   | yes      | Human-readable name. Also used as tool name when exposed to agents.            |
| `description` | string   | no       | Description of what this memory provides. Used as tool description for agents. |
| `type`        | enum     | yes      | One of: `rag`, `documents`, `paths`                                            |
| `config`      | object   | yes      | Type-specific configuration (see below)                                        |
| `project_id`  | string   | yes      | The project this memory belongs to                                             |
| `created_at`  | datetime | auto     |                                                                                |
| `updated_at`  | datetime | auto     |                                                                                |

### Memory Types

#### `rag`

Performs semantic search over project documents using embeddings.

```json
{
  "type": "rag",
  "config": {
    "search": "bitcoin price analysis",
    "limit": 10
  }
}
```

| Config Field | Type   | Required | Default | Description                              |
| ------------ | ------ | -------- | ------- | ---------------------------------------- |
| `search`     | string | yes      | —       | The search query for semantic similarity |
| `limit`      | number | no       | 10      | Maximum number of documents to return    |

#### `documents`

Fetches specific documents by their IDs.

```json
{
  "type": "documents",
  "config": {
    "document_ids": ["doc_abc123", "doc_def456"]
  }
}
```

| Config Field   | Type     | Required | Description                             |
| -------------- | -------- | -------- | --------------------------------------- |
| `document_ids` | string[] | yes      | List of document public IDs to retrieve |

#### `paths`

Matches documents whose file path starts with the given prefixes.

```json
{
  "type": "paths",
  "config": {
    "paths": ["/knowledge-base/bitcoin/", "/reports/2024/"]
  }
}
```

| Config Field | Type     | Required | Description                              |
| ------------ | -------- | -------- | ---------------------------------------- |
| `paths`      | string[] | yes      | Path prefixes to match documents against |

### Query Result

When a memory is queried (via the API or internally by an agent/chat), it returns an **array of documents** — not a pre-formatted string. The consumer is responsible for formatting the documents into system messages or any other shape.

```json
{
  "documents": [
    {
      "id": "doc_abc123",
      "title": "Bitcoin Basics",
      "content": "Bitcoin is a decentralized...",
      "score": 0.92
    }
  ]
}
```

- `score` is present only for `rag` type (semantic similarity score).
- `documents` and `paths` types return documents without a score.

## Attachment to Agents and Chats

### Persisted Defaults

Memories can be permanently attached to an agent or chat via a join table. These are the **default memories** that are always resolved when the agent/chat runs.

- Attach: `POST /api/v1/agents/:agentId/memories` with `{ "memory_id": "mem_..." }`
- Detach: `DELETE /api/v1/agents/:agentId/memories/:memoryId`
- List: `GET /api/v1/agents/:agentId/memories`
- Same endpoints exist for chats: `/api/v1/chats/:chatId/memories`

### Per-Request Supplement

Callers can pass `memory_ids` in the generate/chat request body. These memories are **merged** with the persisted defaults (union, deduplicated). Per-request memories do **not** override or replace defaults — they add to them.

```json
POST /api/v1/agents/:agentId/generate
{
  "messages": [...],
  "memory_ids": ["mem_extra1", "mem_extra2"]
}
```

Final memory set = `persistedMemories ∪ requestMemories`

To remove a default memory, detach it from the agent — not via per-request override.

### Multiple Memories

Agents and chats can have **many memories** attached. Each memory is resolved independently. The resulting documents from all memories are combined and injected as system messages.

## Permissions

### Memory CRUD

| Permission              | Endpoint                                |
| ----------------------- | --------------------------------------- |
| `memories:CreateMemory` | `POST /api/v1/memories`                 |
| `memories:ListMemories` | `GET /api/v1/memories`                  |
| `memories:GetMemory`    | `GET /api/v1/memories/:memoryId`        |
| `memories:UpdateMemory` | `PUT /api/v1/memories/:memoryId`        |
| `memories:DeleteMemory` | `DELETE /api/v1/memories/:memoryId`     |
| `memories:GetMemory`    | `POST /api/v1/memories/:memoryId/query` |

### Attachment Permissions

Attaching/detaching memories to agents uses **agent permissions** (`agents:UpdateAgent`).
Attaching/detaching memories to chats uses **chat permissions** (`chats:UpdateChat`).

### Document Access Scoping

When a memory is queried, the underlying document search is scoped by the **calling user's `projectIds`**. This means:

- A user can only see documents they have access to, even through an agent's memory.
- The permission chain flows: user → agent/chat handler → memory resolution → document search, all using the same `projectIds`.
- No additional permission checks are needed — the existing `projectIds` scoping on `searchDocuments`, `getDocument`, and file queries handles it.

## REST API

All body fields use `snake_case` per project convention.

| Method | Path                                         | Description                          |
| ------ | -------------------------------------------- | ------------------------------------ |
| POST   | `/api/v1/memories`                           | Create a memory                      |
| GET    | `/api/v1/memories`                           | List memories in accessible projects |
| GET    | `/api/v1/memories/:memoryId`                 | Get a memory by ID                   |
| PUT    | `/api/v1/memories/:memoryId`                 | Update a memory                      |
| DELETE | `/api/v1/memories/:memoryId`                 | Delete a memory                      |
| POST   | `/api/v1/memories/:memoryId/query`           | Query a memory and return documents  |
| POST   | `/api/v1/agents/:agentId/memories`           | Attach a memory to an agent          |
| GET    | `/api/v1/agents/:agentId/memories`           | List memories attached to an agent   |
| DELETE | `/api/v1/agents/:agentId/memories/:memoryId` | Detach a memory from an agent        |
| POST   | `/api/v1/chats/:chatId/memories`             | Attach a memory to a chat            |
| GET    | `/api/v1/chats/:chatId/memories`             | List memories attached to a chat     |
| DELETE | `/api/v1/chats/:chatId/memories/:memoryId`   | Detach a memory from a chat          |

### Query Endpoint

`POST /api/v1/memories/:memoryId/query` allows users to preview/test what a memory returns. This is also the internal code path used by agents and chats at generation time.

Optional request body for `rag` type:

```json
{
  "search": "override search query"
}
```

Response:

```json
{
  "documents": [
    {
      "id": "doc_abc123",
      "title": "Bitcoin Basics",
      "content": "...",
      "score": 0.92
    }
  ]
}
```

## Data Model

### Memory Table

| Column      | DB Type   | Notes                                |
| ----------- | --------- | ------------------------------------ |
| id          | UUID      | Internal primary key (never exposed) |
| publicId    | VARCHAR   | `mem_` + nanoid, exposed as `id`     |
| name        | VARCHAR   | Required                             |
| description | TEXT      | Optional                             |
| type        | ENUM      | `rag`, `documents`, `paths`          |
| config      | JSONB     | Type-specific config object          |
| projectId   | INTEGER   | FK → Project                         |
| createdAt   | TIMESTAMP |                                      |
| updatedAt   | TIMESTAMP |                                      |

### AgentMemory Join Table

| Column    | DB Type   | Notes                |
| --------- | --------- | -------------------- |
| id        | UUID      | Internal primary key |
| agentId   | INTEGER   | FK → Agent           |
| memoryId  | INTEGER   | FK → Memory          |
| createdAt | TIMESTAMP |                      |

### ChatMemory Join Table

| Column    | DB Type   | Notes                |
| --------- | --------- | -------------------- |
| id        | UUID      | Internal primary key |
| chatId    | INTEGER   | FK → Chat            |
| memoryId  | INTEGER   | FK → Memory          |
| createdAt | TIMESTAMP |                      |

## Agent/Chat Integration

When an agent or chat generates a response:

1. Collect persisted memories (from join table) and per-request `memory_ids`.
2. Merge into a deduplicated set.
3. For each memory, call `queryMemory({ memoryId, projectIds })`.
4. Combine all returned documents.
5. Format documents into system messages and prepend to the conversation.

Each document becomes a system message:

```
[Document: Bitcoin Basics]
Bitcoin is a decentralized digital currency...
```

## Implementation Checklist

- [ ] **DB Model**: `Memory.ts`, `AgentMemory.ts`, `ChatMemory.ts` in `packages/postgresdb/src/models/`
- [ ] **Public ID**: Register `mem_` prefix in `packages/postgresdb/src/utils/publicId.ts`
- [ ] **Model index**: Export new models from `packages/postgresdb/src/models/index.ts`
- [ ] **Business logic**: `packages/server/src/lib/memories.ts`
- [ ] **REST routes**: `packages/server/src/rest/v1/memories.ts`
- [ ] **OpenAPI spec**: `packages/server/src/rest/openapi/v1/memories.yaml`
- [ ] **Route registration**: Mount in `packages/server/src/rest/v1/index.ts`
- [ ] **Agent/chat attachment routes**: Add memory sub-routes to agents and chats routers
- [ ] **Agent/chat integration**: Modify `createGeneration` and chat flow to resolve memories
- [ ] **soat-tools**: `packages/server/src/lib/soat-tools/memories.ts`
- [ ] **MCP tools**: `packages/server/src/mcp/tools/memories.ts`
- [ ] **Documentation**: `packages/website/docs/modules/memories.md`
- [ ] **Unit tests**: `packages/server/tests/unit/tests/memories.test.ts`
- [ ] **MCP tests**: Add memory tool tests to `packages/server/tests/unit/tests/mcp.test.ts`
- [ ] **Smoke tests**: Add memory steps to `tests/smoke-tests.sh`

## Future Extensions

These are **not** in scope for V1 but are natural additions:

| Feature                  | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `type: 'conversational'` | Auto-extract facts from chat history (Mem0/ChatGPT pattern) |
| Agent self-editing       | Agent can create/update memories via tools (Letta pattern)  |
| `type: 'episodic'`       | Few-shot examples from past successful interactions         |
| Background processing    | Async memory refinement between conversations (sleep-time)  |
