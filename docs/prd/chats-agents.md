# PRD: Secrets, AI Providers, Chats, and Agents

## Context

Soat acts as an **LLM Gateway**: applications call Soat instead of calling LLM providers directly. Soat adds auth, routing, logging, and cost tracking as middleware. Applications swap only `baseURL` and `apiKey` — no other client-side changes required.

Four modules work together to deliver this:

| Module       | Role                                               |
| ------------ | -------------------------------------------------- |
| Secrets      | Store credentials (API keys, OAuth tokens, etc.)   |
| AI Providers | Configure a provider + model using a secret        |
| Chats        | OpenAI-compatible request → response conversations |
| Agents       | Multi-step tool-using workflows (ReAct loop)       |

Dependency chain: **Secrets ← AI Providers ← Chats / Agents**

---

## Module: Secrets

### Overview

The Secrets module stores sensitive credentials scoped to a project. A secret can hold any kind of credential: an AI provider API key, Google service account JSON, OAuth refresh tokens, or arbitrary key-value pairs. Secrets are encrypted at rest and their values are never returned in API responses after creation.

### Data Model

- `Secret` — a named credential; scoped to a `Project`
  - `publicId` — `sec_` prefix
  - `projectId` — FK to `Project`
  - `name` — human-readable label (e.g., "OpenAI Production Key")
  - `value` — encrypted JSON string; can hold any structure (a plain string for API keys, a JSON object for Google credentials, etc.)
  - `createdAt`, `updatedAt`

### API

```
POST   /v1/secrets                Create a secret
GET    /v1/secrets                List secrets (scoped to project; values redacted)
GET    /v1/secrets/{secretId}     Get secret metadata (value redacted)
PATCH  /v1/secrets/{secretId}     Update a secret (name, type, or value)
DELETE /v1/secrets/{secretId}     Delete a secret
```

### Behaviour

- **Value is write-only**: `POST` and `PATCH` accept a `value` field; `GET` never returns it. List/Get responses include a `hasValue: true` flag instead.
- **Encryption**: values are encrypted with AES-256-GCM using a server-managed key (`SECRETS_ENCRYPTION_KEY` env var) before being stored in the database.
- **Cascade**: deleting a secret that is referenced by an AI provider returns `409 Conflict` unless `force=true` is passed (which also deletes dependent AI providers).

### Public ID prefix

`sec_`

---

## Module: AI Providers

### Overview

The AI Providers module configures a connection to an AI model provider. Each AI provider references a secret (for credentials) and specifies a provider type and default model. A project can have multiple AI providers — e.g., two separate OpenAI providers with different API keys, plus an Anthropic provider.

Chats and Agents reference an AI provider instead of specifying model/credentials directly. This decouples credential management from LLM usage.

### Data Model

- `AiProvider` — a configured provider instance; scoped to a `Project`
  - `publicId` — `aip_` prefix
  - `projectId` — FK to `Project`
  - `secretId` — FK to `Secret` (the credential to authenticate with the provider)
  - `name` — human-readable label (e.g., "Claude Production", "OpenAI Internal")
  - `provider` — provider slug matching the Vercel AI SDK gateway format: `openai` | `anthropic` | `google` | `xai` | `groq` | `ollama` | `azure` | `bedrock` | `custom`
  - `defaultModel` — default model ID (e.g., `gpt-4o`, `claude-sonnet-4`, `llama3.2`); can be overridden per-request
  - `baseUrl` — optional; custom API base URL (for self-hosted or proxy endpoints)
  - `config` — optional JSON; provider-specific settings (e.g., `{ "organization": "org-xxx" }` for OpenAI, `{ "region": "us-east-1" }` for Bedrock)
  - `createdAt`, `updatedAt`

### API

```
POST   /v1/ai-providers                    Create an AI provider
GET    /v1/ai-providers                    List AI providers (scoped to project)
GET    /v1/ai-providers/{aiProviderId}     Get AI provider details
PATCH  /v1/ai-providers/{aiProviderId}     Update an AI provider
DELETE /v1/ai-providers/{aiProviderId}     Delete an AI provider
```

### Behaviour

- **Secret resolution**: when Chats or Agents use an AI provider, the server decrypts the referenced secret to build the provider client. The decrypted value is never exposed to the caller.
- **Vercel AI SDK integration**: at runtime, each AI provider maps to a Vercel AI SDK provider instance. For example, an `openai` provider creates an `@ai-sdk/openai` instance configured with the decrypted API key and optional base URL.
- **Multiple providers per project**: a project may have several AI providers of the same type (e.g., two OpenAI providers for different teams/budgets) or different types.
- **Cascade**: deleting an AI provider that is referenced as a default by chats returns `409 Conflict` unless `force=true`.

### Public ID prefix

`aip_`

### Provider → AI SDK Mapping

| `provider` value | AI SDK package            | Auth from secret      |
| ---------------- | ------------------------- | --------------------- |
| `openai`         | `@ai-sdk/openai`          | `apiKey`              |
| `anthropic`      | `@ai-sdk/anthropic`       | `apiKey`              |
| `google`         | `@ai-sdk/google`          | `apiKey`              |
| `xai`            | `@ai-sdk/xai`             | `apiKey`              |
| `groq`           | `@ai-sdk/groq`            | `apiKey`              |
| `azure`          | `@ai-sdk/azure`           | `apiKey` + `baseUrl`  |
| `bedrock`        | `@ai-sdk/amazon-bedrock`  | `google_credentials`  |
| `ollama`         | `ollama-ai-provider`      | none (local)          |
| `gateway`        | `ai` (built-in gateway)   | `apiKey` (AI Gateway) |
| `custom`         | OpenAI-compatible wrapper | `apiKey` + `baseUrl`  |

---

## Module: Chats

### Overview

The Chats module exposes an **OpenAI Chat Completions-compatible API** for **stateless, single-call completions**. Any client already using the OpenAI SDK can point its `baseURL` at Soat and work without code changes.

Chats are **not** persistent — every request is self-contained. The caller sends the full message array each time. For persistent conversation history, use the **Conversations** module instead. An application can use Conversations without Chats, and vice versa.

### Data Model

Chats are stateless — no new DB entity is required. Each request is processed and returned without storing messages.

### API

```
POST   /v1/chats/completions              Send messages and get a completion
```

#### `POST /v1/chats/completions`

Request body mirrors OpenAI's `POST /v1/chat/completions`:

```json
{
  "aiProviderId": "aip_V1StGXR8Z5jdHi6B",
  "model": "gpt-4o",
  "messages": [{ "role": "user", "content": "What files do I have?" }],
  "stream": false
}
```

- `aiProviderId` — optional; specifies which AI provider to use for this request
- `model` — optional; overrides the AI provider's `defaultModel`
- `messages` — the full message array (system, user, assistant turns); the caller manages history
- `stream` — `false` returns JSON; `true` returns SSE (`text/event-stream`)

**Resolution order for provider/model:**

1. `aiProviderId` on the request body
2. Fallback: `CHAT_MODEL` env var with default Ollama (backward compat)

Response (non-streaming) mirrors OpenAI's response shape:

```json
{
  "object": "chat.completion",
  "model": "gpt-4o",
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

- Each call is **stateless** — Soat does not store or accumulate messages. The caller is responsible for managing conversation history and sending the full message array on every request.
- No tool execution. If an application needs tools, it uses the Agents module.
- The AI provider determines which SDK client and credentials are used. The server decrypts the secret, instantiates the appropriate Vercel AI SDK provider, and calls `generateText` or `streamText`.

### Relationship with Conversations

Chats and Conversations are **independent modules**:

| Aspect      | Chats                            | Conversations                      |
| ----------- | -------------------------------- | ---------------------------------- |
| State       | Stateless (single API call)      | Persistent (messages stored in DB) |
| History     | Caller manages message array     | Soat manages message history       |
| Use case    | Direct LLM proxy / quick prompts | Multi-turn sessions with recall    |
| Data stored | None                             | ConversationMessage per turn       |

An application can use either or both modules depending on its needs.

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

Already implemented (to be updated). Request:

```json
{
  "aiProviderId": "aip_V1StGXR8Z5jdHi6B",
  "model": "gpt-4o",
  "prompt": "Summarise all documents in project proj_XYZ"
}
```

- `aiProviderId` — required (or fallback to `AGENT_MODEL` env var + Ollama for backward compat)
- `model` — optional; overrides the AI provider's `defaultModel`

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

Migrate to **Vercel AI SDK**: install `ai` + provider-specific packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.). This enables:

- **Chats**: `generateText` / `streamText` for OpenAI-compatible completions
- **Agents**: `generateText` with `maxSteps` for the ReAct tool loop
- **AI Providers**: each `AiProvider` record maps to a Vercel AI SDK provider instance at runtime

### Provider instantiation (runtime)

```ts
// Pseudocode: resolving an AI provider to a Vercel AI SDK model
const resolveModel = async (aiProviderId: string) => {
  const aiProvider = await db.AiProvider.findOne({
    where: { publicId: aiProviderId },
  });
  const secret = await db.Secret.findOne({
    where: { id: aiProvider.secretId },
  });
  const decryptedValue = decrypt(secret.value);

  switch (aiProvider.provider) {
    case 'openai':
      return createOpenAI({
        apiKey: decryptedValue,
        baseURL: aiProvider.baseUrl,
      })(aiProvider.defaultModel);
    case 'anthropic':
      return createAnthropic({ apiKey: decryptedValue })(
        aiProvider.defaultModel
      );
    case 'ollama':
      return ollama(aiProvider.defaultModel);
    // ... other providers
  }
};
```

### Encryption for Secrets

- Algorithm: AES-256-GCM
- Key: `SECRETS_ENCRYPTION_KEY` environment variable (32 bytes, hex or base64 encoded)
- Each secret gets a random IV stored alongside the ciphertext
- Storage format: `iv:ciphertext:authTag` (all base64)

### Module file locations (following codebase conventions)

```
packages/postgresdb/src/models/Secret.ts          (new)
packages/postgresdb/src/models/AiProvider.ts       (new)

packages/server/src/lib/secrets.ts                 (new)
packages/server/src/lib/aiProviders.ts             (new)
packages/server/src/lib/chats.ts                   (new)
packages/server/src/lib/agents.ts                  (exists, extend)

packages/server/src/rest/v1/secrets.ts             (new)
packages/server/src/rest/v1/aiProviders.ts         (new)
packages/server/src/rest/v1/chats.ts               (new)
packages/server/src/rest/v1/agents.ts              (exists, extend)

packages/server/src/mcp/tools/secrets.ts           (new)
packages/server/src/mcp/tools/aiProviders.ts       (new)
packages/server/src/mcp/tools/chats.ts             (new)
packages/server/src/mcp/tools/agents.ts            (new)

packages/website/docs/modules/secrets.md           (new)
packages/website/docs/modules/ai-providers.md      (new)
packages/website/docs/modules/chats.md             (new)
packages/website/docs/modules/agents.md            (new)

packages/server/tests/unit/tests/secrets.test.ts       (new)
packages/server/tests/unit/tests/aiProviders.test.ts   (new)
packages/server/tests/unit/tests/chats.test.ts         (new)
packages/server/tests/unit/tests/agents.test.ts        (new)
```

### Implementation order

1. **Secrets** — no dependencies; foundation for everything else
2. **AI Providers** — depends on Secrets
3. **Chats** — depends on AI Providers; stateless, no new DB models needed
4. **Agents** — depends on AI Providers; extends existing agent streaming
