# PRD: Chats and Agents Modules

## Context

Soat acts as an **LLM Gateway**: applications call Soat instead of calling LLM providers directly. Soat adds auth, routing, logging, and cost tracking as middleware. Applications swap only `baseURL` and `apiKey` — no other client-side changes required.

Two distinct interaction patterns emerge from this role, each deserving its own module:

|           | Chats                    | Agents                        |
| --------- | ------------------------ | ----------------------------- |
| Pattern   | Request → Response       | Loop until goal is reached    |
| Tools     | No                       | Yes                           |
| Latency   | Short                    | Variable (seconds to minutes) |
| API shape | OpenAI-compatible        | Soat-native                   |
| State     | Per-conversation history | Per-run scratchpad            |

---

## Module: Chats

### Overview

The Chats module exposes an **OpenAI Chat Completions-compatible API**. Any client already using the OpenAI SDK can point its `baseURL` at Soat and work without code changes.

Conversations are persistent: a chat has an ID, and messages accumulate in it across multiple calls.

### Data Model

The existing `Conversation` and `ConversationMessage` models map directly:

- `Conversation` — the chat session; scoped to a `Project`; has a `status` (`open` | `closed`)
- `ConversationMessage` — a single turn; references a `Document` (message content stored as a file), an `Actor` (sender), and a `position` (ordering within the conversation)
- `Actor` — the identity sending a message; scoped to a `Project`; carries an `externalId` for the calling application to use its own user IDs

### API

```
POST   /v1/chats                                   Create a new chat
GET    /v1/chats                                   List chats (scoped to project)
GET    /v1/chats/{chatId}                          Get chat metadata
DELETE /v1/chats/{chatId}                          Delete a chat and all messages

POST   /v1/chats/{chatId}/completions              Send a message and get a completion
GET    /v1/chats/{chatId}/messages                 List messages in a chat
```

#### `POST /v1/chats/{chatId}/completions`

Request body mirrors OpenAI's `POST /v1/chat/completions`:

```json
{
  "model": "llama3.2",
  "messages": [{ "role": "user", "content": "What files do I have?" }],
  "stream": false
}
```

- `model` — optional; falls back to `CHAT_MODEL` env var
- `messages` — the new turn(s) to append; prior history is loaded from the DB automatically
- `stream` — `false` returns JSON; `true` returns SSE (`text/event-stream`)

Response (non-streaming) mirrors OpenAI's response shape:

```json
{
  "id": "conv_V1StGXR8Z5jdHi6B",
  "object": "chat.completion",
  "model": "llama3.2",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "You have 3 files: ..." },
      "finish_reason": "stop"
    }
  ]
}
```

Streaming response: SSE chunks with `data: {"choices":[{"delta":{"content":"..."}}]}` matching the OpenAI streaming format, terminated with `data: [DONE]`.

### Behaviour

- Each call to `/completions` **appends** the incoming messages and the model's reply to the conversation's message history.
- The full prior history is passed to the LLM on each call.
- History trimming (context window management) is handled transparently by Soat.
- No tool execution. If an application needs tools, it uses the Agents module.

### Public ID prefix

`chat_` — introduced alongside this module. The existing `conv_` prefix on `Conversation` maps to chats.

---

## Module: Agents

### Overview

The Agents module executes **multi-step, tool-using workflows**. The caller provides a goal; the agent decides which tools to call and in what order until the goal is met or a step limit is reached.

This is the ReAct loop pattern: Reason → Act → Observe → repeat.

There is no OpenAI-compatible wrapper here — the API surface is Soat-native because no equivalent standard exists for agentic loops.

### Data Model

Agents do not require a persistent DB entity for most use cases (a run is ephemeral). Future iterations may persist run history, but v1 is stateless per run.

If persistence is needed in the future:

- `AgentRun` — one execution; has a `status` (`running` | `completed` | `failed`), a `goal`, and a reference to the project
- `AgentStep` — one ReAct iteration within a run; stores the model's reasoning, the tool called, and the tool result

### API

```
POST /v1/agents/run          Run an agent to completion (blocking, JSON response)
POST /v1/agents/run/stream   Run an agent with streaming output (SSE)
```

#### `POST /v1/agents/run/stream`

Already implemented. Request:

```json
{
  "model": "qwen2.5:0.5b",
  "prompt": "Summarise all documents in project proj_XYZ"
}
```

Response: SSE chunks:

```
data: {"text":"I'll look at the documents..."}
data: {"text":" Here is the summary:"}
data: {"event":"done"}
```

#### `POST /v1/agents/run` (future)

Same request body; returns when the agent finishes:

```json
{
  "runId": "run_V1StGXR8Z5jdHi6B",
  "status": "completed",
  "result": "...",
  "steps": 4
}
```

### Tools available to agents

Tools are registered from the MCP tool definitions. Current tool surface:

| Tool                 | Description             |
| -------------------- | ----------------------- |
| `list-files`         | List files in a project |
| `list-documents`     | List documents          |
| `list-conversations` | List conversations      |
| `list-projects`      | List projects           |
| `list-actors`        | List actors             |

Future tool additions (e.g. `create-document`, `search-documents`) extend the registry without changing the agent API.

### Stop conditions (v1)

- Default: maximum 20 steps
- Agent emits a `done` step with no tool call

---

## Implementation Notes

### SDK dependency

Current state: `ollama@^0.6.3` (native). No tool loop.

To implement the Agents module properly (tool execution, multi-step), either:

1. **Stay native**: implement a manual ReAct loop with `ollama.chat()` + tool dispatch
2. **Migrate to Vercel AI SDK**: install `ai` + `@ai-sdk/ollama`; use `ToolLoopAgent` for modes 3–8 and `streamText` for the Chats module

Option 2 is preferred: `ToolLoopAgent` handles stop conditions, context trimming, and dynamic tool selection out of the box. `streamText` produces an OpenAI-compatible streaming format needed by the Chats module.

### Module file locations (following codebase conventions)

```
packages/server/src/lib/chats.ts
packages/server/src/rest/v1/chats.ts
packages/server/src/mcp/tools/chats.ts
packages/website/docs/modules/chats.md

packages/server/src/lib/agents.ts          (exists, extend)
packages/server/src/rest/v1/agents.ts      (exists, extend)
packages/server/src/mcp/tools/agents.ts    (new)
packages/website/docs/modules/agents.md    (new)
```

### Migration from `conversations` to `chats`

The existing `Conversation` / `ConversationMessage` models are reused as-is. The Chats REST module is a new API layer on top of the same DB tables. The existing `conversations` REST routes remain until deprecated.
