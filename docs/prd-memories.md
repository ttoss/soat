# PRD: Memory Module

## Overview

The Memory module provides a project-scoped mechanism for storing and retrieving knowledge. A **memory** is a named container that accumulates atomic facts (entries) via a deduplication and merge algorithm.

A project can have **many memories**, each representing a different knowledge domain (e.g., "Customer Preferences", "Project Context", "Technical Decisions"). Entries written to a memory are automatically deduplicated within that memory's scope.

Searching across memories and documents is handled by the **knowledge module** (`POST /api/v1/knowledge/search`). The memory module owns storage and write logic only — it does not expose its own search endpoint.

This module resolves two roadmap items:

- **Agent Memory (P2)** — persistent, project-scoped knowledge for agents
- **Conversational Memory** — auto-extract facts from conversations

## Key Concepts

### Memory (Container)

A memory is a named, project-scoped knowledge container. It groups related entries and defines the dedup scope.

| Field         | Type     | Required | Description                                        |
| ------------- | -------- | -------- | -------------------------------------------------- |
| `id`          | string   | auto     | Public ID with `mem_` prefix                       |
| `project_id`  | string   | yes      | The project this memory belongs to                 |
| `name`        | string   | yes      | Human-readable name (e.g., "Customer Preferences") |
| `description` | string   | no       | Description of what this memory stores             |
| `created_at`  | datetime | auto     |                                                    |
| `updated_at`  | datetime | auto     |                                                    |

### Memory Entry

A memory entry is an atomic piece of knowledge stored inside a memory. Entries are the units of knowledge.

| Field        | Type     | Required | Description                                                                 |
| ------------ | -------- | -------- | --------------------------------------------------------------------------- |
| `id`         | string   | auto     | Public ID with `me_` prefix                                                 |
| `memory_id`  | string   | auto     | The memory this entry belongs to                                            |
| `content`    | string   | yes      | The knowledge content (a single fact, observation, or piece of information) |
| `source`     | string   | auto     | How the entry was created: `manual`, `agent`, `extraction`                  |
| `embedding`  | vector   | auto     | Embedding vector for semantic search (generated on create/update)           |
| `created_at` | datetime | auto     |                                                                             |
| `updated_at` | datetime | auto     |                                                                             |

**Source types:**

- `manual` — created by a user via the REST API
- `agent` — created by an agent via the `write_memory` soat-tool during a generation
- `extraction` — created by the automatic extraction system after a conversation turn

**Design principles:**

- Entries are **atomic** — one fact per entry (e.g., "Customer prefers email communication", not a paragraph mixing multiple facts).
- Entries are **memory-scoped** — deduplication runs within a single memory's entries. Different memories can hold related facts independently.
- Entries are **automatically deduplicated** — the write algorithm prevents duplicate and near-duplicate entries within a memory.
- Entries are **mutable** — they can be merged with new information or manually updated.
- Entries are **embedded** — each entry has an embedding vector computed from its content, enabling semantic search.

### Relationship to Documents and Knowledge

Memories and documents are independent storage systems. The **knowledge module** provides a unified search layer across both.

| Concern            | Memories                           | Documents                         | Knowledge                            |
| ------------------ | ---------------------------------- | --------------------------------- | ------------------------------------ |
| What it stores     | Atomic facts (1–2 sentences)       | Full content (files, pages, etc.) | Nothing — query orchestrator only    |
| How content enters | Write algorithm (dedup/merge/skip) | Upload or create                  | —                                    |
| Search endpoint    | —                                  | —                                 | `POST /api/v1/knowledge/search`      |
| Managed by         | System (automatic dedup)           | User (manual upload)              | System (unified retrieval + ranking) |

See the [Knowledge Module PRD](./prd-knowledge.md) for details.

## Write Algorithm

Every write to a memory — manual, agent, or extraction — goes through the same algorithm. The caller provides `content` and the system determines the outcome. Dedup is scoped to the target memory.

```
Input: content (string), memory_id

STEP 1 — EMBED
  Generate embedding for the content.

STEP 2 — SEARCH
  Search existing entries in this memory by cosine similarity.
  Let topMatch = highest-similarity existing entry.

STEP 3 — DECIDE

  CASE 1: topMatch.score ≥ DUPLICATE_THRESHOLD (default 0.95)
    → SKIP. The fact is already known.
    Return { action: "skipped", entry: topMatch }

  CASE 2: topMatch.score ≥ UPDATE_THRESHOLD (default 0.75)
    → MERGE. The fact overlaps with existing knowledge.
    Prompt an LLM:
      "Given the existing fact and the new fact, produce a single
       updated fact that combines both. If they contradict,
       prefer the new information."
      Input: { existing: topMatch.content, new: content }
      Output: { merged: string }
    Update topMatch: content = merged, re-generate embedding, update updated_at.
    Return { action: "updated", entry: topMatch }

  CASE 3: topMatch.score < UPDATE_THRESHOLD (or no existing entries)
    → CREATE. This is genuinely new knowledge.
    Create a new entry with the provided content and embedding.
    Return { action: "created", entry: newEntry }
```

### Why This Algorithm Works

The two-threshold approach handles three scenarios cleanly:

- **High similarity (≥ 0.95):** "The user likes Python" vs "User prefers Python" → same fact, skip.
- **Medium similarity (0.75–0.95):** "The user likes Python" vs "The user likes Python 3.12 specifically" → related, merge into a richer fact.
- **Low similarity (< 0.75):** "The user likes Python" vs "The project deadline is Friday" → unrelated, create new entry.

The LLM-based merge step handles nuance that pure embedding similarity cannot: contradiction resolution, information enrichment, and phrasing consolidation.

### Threshold Configuration

Thresholds can be overridden per request via optional fields in the write endpoint body:

| Field                 | Type   | Default | Description                               |
| --------------------- | ------ | ------- | ----------------------------------------- |
| `duplicate_threshold` | number | 0.95    | Similarity above which content is skipped |
| `update_threshold`    | number | 0.75    | Similarity above which content merges     |

### Examples

**First write — no existing entries:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer prefers email over phone calls" }

→ { "action": "created", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls", ... } }
```

**Duplicate write — same fact rephrased:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "The customer likes email more than phone" }

→ { "action": "skipped", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls", ... } }
```

**Merge write — related fact with new detail:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer prefers email, especially for billing inquiries" }

→ { "action": "updated", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls, especially for billing inquiries", ... } }
```

**Unrelated write — new fact:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer fiscal year ends in March" }

→ { "action": "created", "entry": { "id": "me_002", "content": "Customer fiscal year ends in March", ... } }
```

## Write Paths

### 1. Manual Write (REST API)

The user calls `POST /api/v1/memories/:memoryId/entries` with `{ "content": "..." }`. The write algorithm runs within that memory and returns the action taken plus the entry.

### 2. Agent Write (soat-tool)

During a generation, an agent can call the `write_memory` tool with `{ "content": "...", "memoryId": "mem_..." }`. The write algorithm runs identically.

### 3. Automatic Extraction (post-conversation)

Runs **after a conversation turn completes** (fire-and-forget, does not block the response). This is the only path that extracts multiple facts from a single input.

```
Input: conversation messages[], target memory_id

STEP 1 — EXTRACT CANDIDATE FACTS
  Prompt an LLM with the conversation context:
    "Extract discrete, atomic facts from this conversation.
     Return a JSON array of { content: string } objects.
     Only extract facts that are worth remembering long-term.
     Skip transient information (greetings, acknowledgments, etc.)."

  → candidates: { content: string }[]

  If candidates is empty → STOP (nothing to remember)

STEP 2 — WRITE EACH CANDIDATE
  For each candidate, run the write algorithm against the target memory.
  Each candidate independently results in create, merge, or skip.

STEP 3 — RETURN
  Return a summary: { created: number, updated: number, skipped: number }
```

Extraction is triggered when an agent or chat with attached memories completes a generation.

## Agent/Chat Integration

### Attaching Memories

Memories are attached to agents or chats so the system knows which memories to query and extract into.

- Attach: `POST /api/v1/agents/:agentId/memories` with `{ "memory_id": "mem_..." }`
- Detach: `DELETE /api/v1/agents/:agentId/memories/:memoryId`
- List: `GET /api/v1/agents/:agentId/memories`
- Same endpoints exist for chats.

When an agent generates a response:

1. **On generate:** the knowledge module searches all attached memories (and documents) using the conversation context and injects relevant results as system messages.
2. **Post-generate (async):** the extraction algorithm runs on the completed conversation turn, writing new facts to each attached memory.

### Agent Memory Tools (soat-tools)

When an agent has memories attached, it gains access to these tools:

| Tool               | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `write_memory`     | Write content to a memory (system decides: create, merge, or skip)   |
| `search_knowledge` | Search across memories and documents (delegated to knowledge module) |

These tools are gated by the agent's boundary policy.

### Context Injection

Relevant memory entries are injected as system messages before the conversation:

```
[Memory: Customer Preferences] Customer prefers email over phone calls, especially for billing inquiries
[Memory: Customer Preferences] Customer fiscal year ends in March
[Memory: Project Context] The deadline is June 15
```

The system selects entries by embedding the latest user message and retrieving the top matches from each attached memory.

## Data Model

### Memory Table

| Column      | Type        | Constraints                     |
| ----------- | ----------- | ------------------------------- |
| id          | INTEGER     | PK, auto-increment              |
| publicId    | VARCHAR(32) | UNIQUE, NOT NULL, `mem_` prefix |
| projectId   | INTEGER     | FK → Project, NOT NULL          |
| name        | VARCHAR     | NOT NULL                        |
| description | TEXT        | NULL                            |
| createdAt   | TIMESTAMP   | NOT NULL                        |
| updatedAt   | TIMESTAMP   | NOT NULL                        |

### MemoryEntry Table

| Column    | Type         | Constraints                    |
| --------- | ------------ | ------------------------------ |
| id        | INTEGER      | PK, auto-increment             |
| publicId  | VARCHAR(32)  | UNIQUE, NOT NULL, `me_` prefix |
| memoryId  | INTEGER      | FK → Memory, NOT NULL          |
| content   | TEXT         | NOT NULL                       |
| source    | VARCHAR(20)  | NOT NULL, enum                 |
| embedding | VECTOR(1536) | NOT NULL                       |
| createdAt | TIMESTAMP    | NOT NULL                       |
| updatedAt | TIMESTAMP    | NOT NULL                       |

**Indexes:**

- `UNIQUE (publicId)` on both tables
- `(memoryId)` — for listing entries within a memory
- `HNSW (embedding)` — for cosine similarity search

### AgentMemory Join Table

| Column    | Type      | Constraints           |
| --------- | --------- | --------------------- |
| id        | INTEGER   | PK, auto-increment    |
| agentId   | INTEGER   | FK → Agent, NOT NULL  |
| memoryId  | INTEGER   | FK → Memory, NOT NULL |
| createdAt | TIMESTAMP | NOT NULL              |

Same pattern for `ChatMemory`.

## Permissions

### Memory CRUD

| Permission              | Endpoint                            |
| ----------------------- | ----------------------------------- |
| `memories:CreateMemory` | `POST /api/v1/memories`             |
| `memories:ListMemories` | `GET /api/v1/memories`              |
| `memories:GetMemory`    | `GET /api/v1/memories/:memoryId`    |
| `memories:UpdateMemory` | `PUT /api/v1/memories/:memoryId`    |
| `memories:DeleteMemory` | `DELETE /api/v1/memories/:memoryId` |

### Entry Operations

| Permission                   | Endpoint                                             |
| ---------------------------- | ---------------------------------------------------- |
| `memories:WriteMemoryEntry`  | `POST /api/v1/memories/:memoryId/entries`            |
| `memories:ListMemoryEntries` | `GET /api/v1/memories/:memoryId/entries`             |
| `memories:GetMemoryEntry`    | `GET /api/v1/memories/:memoryId/entries/:entryId`    |
| `memories:UpdateMemoryEntry` | `PUT /api/v1/memories/:memoryId/entries/:entryId`    |
| `memories:DeleteMemoryEntry` | `DELETE /api/v1/memories/:memoryId/entries/:entryId` |

### Attachment Permissions

Attaching/detaching memories to agents uses `agents:UpdateAgent`.
Attaching/detaching memories to chats uses `chats:UpdateChat`.

## REST API

All body fields use `snake_case` per project convention.

### Memory CRUD

| Method | Path                         | Description                          |
| ------ | ---------------------------- | ------------------------------------ |
| POST   | `/api/v1/memories`           | Create a memory                      |
| GET    | `/api/v1/memories`           | List memories in accessible projects |
| GET    | `/api/v1/memories/:memoryId` | Get a memory by ID                   |
| PUT    | `/api/v1/memories/:memoryId` | Update a memory                      |
| DELETE | `/api/v1/memories/:memoryId` | Delete a memory and all its entries  |

### Entry Operations

| Method | Path                                          | Description                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------ |
| POST   | `/api/v1/memories/:memoryId/entries`          | Write content (system decides: create, merge, or skip) |
| GET    | `/api/v1/memories/:memoryId/entries`          | List entries in a memory                               |
| GET    | `/api/v1/memories/:memoryId/entries/:entryId` | Get an entry by ID                                     |
| PUT    | `/api/v1/memories/:memoryId/entries/:entryId` | Manually update an entry (bypasses dedup)              |
| DELETE | `/api/v1/memories/:memoryId/entries/:entryId` | Delete an entry                                        |

### Agent/Chat Attachment

| Method | Path                                         | Description                        |
| ------ | -------------------------------------------- | ---------------------------------- |
| POST   | `/api/v1/agents/:agentId/memories`           | Attach a memory to an agent        |
| GET    | `/api/v1/agents/:agentId/memories`           | List memories attached to an agent |
| DELETE | `/api/v1/agents/:agentId/memories/:memoryId` | Detach a memory from an agent      |
