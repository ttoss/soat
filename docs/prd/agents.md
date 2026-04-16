# Agents Module — Implementation Steps

Reference: [`packages/website/docs/modules/agents.md`](../../packages/website/docs/modules/agents.md)

---

## Phase 1: Database Models

### 1.1 Register Public ID Prefixes

**File:** `packages/postgresdb/src/utils/publicId.ts`

Add four new prefixes to `PUBLIC_ID_PREFIXES`:

| Entity     | Prefix       |
| ---------- | ------------ |
| agent      | `agt_`       |
| agentTool  | `agt_tool_`  |
| generation | `agt_gen_`   |
| trace      | `agt_trace_` |

### 1.2 Create `AgentTool` Model

**File:** `packages/postgresdb/src/models/AgentTool.ts`

Follow the `Chat` model pattern (`@Table`, `beforeValidate` hook for `publicId`).

| Column        | Type       | Nullable | Notes                                                 |
| ------------- | ---------- | -------- | ----------------------------------------------------- |
| `id`          | INTEGER    | PK       | Auto-increment                                        |
| `publicId`    | STRING(32) | no       | Unique, generated from `agt_tool_` prefix             |
| `projectId`   | INTEGER    | no       | FK → `Project`                                        |
| `type`        | STRING     | no       | `http` \| `client` \| `mcp` \| `soat`, default `http` |
| `name`        | STRING     | no       | Tool name / namespace prefix                          |
| `description` | TEXT       | yes      |                                                       |
| `parameters`  | JSONB      | yes      | JSON Schema — required for `http`/`client`            |
| `execute`     | JSONB      | yes      | `{ url, headers? }` — required for `http`             |
| `mcp`         | JSONB      | yes      | `{ url, headers? }` — required for `mcp`              |
| `actions`     | JSONB      | yes      | String array — required for `soat`                    |

### 1.3 Create `Agent` Model

**File:** `packages/postgresdb/src/models/Agent.ts`

| Column           | Type       | Nullable | Notes                                                    |
| ---------------- | ---------- | -------- | -------------------------------------------------------- |
| `id`             | INTEGER    | PK       | Auto-increment                                           |
| `publicId`       | STRING(32) | no       | Unique, generated from `agt_` prefix                     |
| `projectId`      | INTEGER    | no       | FK → `Project`                                           |
| `aiProviderId`   | INTEGER    | no       | FK → `AiProvider`                                        |
| `name`           | STRING     | yes      |                                                          |
| `instructions`   | TEXT       | yes      |                                                          |
| `model`          | STRING     | yes      | Falls back to AI provider's `defaultModel`               |
| `toolIds`        | JSONB      | yes      | Array of `agt_tool_` public IDs                          |
| `maxSteps`       | INTEGER    | yes      | Default `20`                                             |
| `toolChoice`     | JSONB      | yes      | `"auto"` \| `"required"` \| `{ type: "tool", toolName }` |
| `stopConditions` | JSONB      | yes      | Array of condition objects                               |
| `activeToolIds`  | JSONB      | yes      | Subset of `toolIds`                                      |
| `stepRules`      | JSONB      | yes      | Array of `{ step, toolChoice?, activeToolIds? }`         |
| `boundaryPolicy` | JSONB      | yes      | `PolicyDocument` — caps soat actions                     |
| `temperature`    | FLOAT      | yes      |                                                          |

### 1.4 Export Models

**File:** `packages/postgresdb/src/models/index.ts`

Add `export { Agent } from './Agent'` and `export { AgentTool } from './AgentTool'`.

### 1.5 Build postgresdb

```bash
pnpm --filter @soat/postgresdb build
```

Then sync the DB (or recreate dev DB if `--alter` fails). See `packages/postgresdb/README.md`.

---

## Phase 2: Permissions

### 2.1 Register Agent Permissions

**File:** `packages/server/src/lib/permissions.ts`

Add the following permission actions (follow existing patterns for other modules):

- `agents:CreateAgent`
- `agents:ListAgents`
- `agents:GetAgent`
- `agents:UpdateAgent`
- `agents:DeleteAgent`
- `agents:CreateAgentGeneration`
- `agents:CreateAgentTool`
- `agents:ListAgentTools`
- `agents:GetAgentTool`
- `agents:UpdateAgentTool`
- `agents:DeleteAgentTool`
- `agents:ListAgentTraces`
- `agents:GetAgentTrace`

---

## Phase 3: Business Logic

### 3.1 Create `agents.ts` Lib

**File:** `packages/server/src/lib/agents.ts`

Follow `chats.ts` patterns: mapped types, map functions, includes, all DB access here.

#### Agent Tool Functions

| Function          | Signature (args object)                                                      | Returns                          |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `createAgentTool` | `{ projectIds, type, name, description, parameters, execute, mcp, actions }` | `MappedAgentTool`                |
| `listAgentTools`  | `{ projectIds }`                                                             | `MappedAgentTool[]`              |
| `getAgentTool`    | `{ projectIds, id }`                                                         | `MappedAgentTool \| 'not_found'` |
| `updateAgentTool` | `{ projectIds, id, ...fields }`                                              | `MappedAgentTool \| 'not_found'` |
| `deleteAgentTool` | `{ projectIds, id }`                                                         | `'ok' \| 'not_found'`            |

#### Agent CRUD Functions

| Function      | Signature (args object)                                                                                                                                         | Returns                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `createAgent` | `{ projectIds, aiProviderId, name, instructions, model, toolIds, maxSteps, toolChoice, stopConditions, activeToolIds, stepRules, boundaryPolicy, temperature }` | `MappedAgent`                |
| `listAgents`  | `{ projectIds }`                                                                                                                                                | `MappedAgent[]`              |
| `getAgent`    | `{ projectIds, id }`                                                                                                                                            | `MappedAgent \| 'not_found'` |
| `updateAgent` | `{ projectIds, id, ...fields }`                                                                                                                                 | `MappedAgent \| 'not_found'` |
| `deleteAgent` | `{ projectIds, id }`                                                                                                                                            | `'ok' \| 'not_found'`        |

#### Generation Functions

| Function            | Description                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `createGeneration`  | Loads agent config, resolves AI provider, resolves tools, runs `generateText` loop, returns result |
| `submitToolOutputs` | Resumes a paused generation (client tool flow), applies overrides, continues loop                  |

#### Trace Functions

| Function     | Description                   |
| ------------ | ----------------------------- |
| `listTraces` | List traces for a project     |
| `getTrace`   | Get a single trace by traceId |

#### Key Implementation Details

- **Tool resolution:** Before calling `generateText`, resolve all `toolIds` into AI SDK `tool()` objects:
  - `http` → tool that POSTs to `execute.url`
  - `client` → tool with `execute: undefined` (triggers pause)
  - `mcp` → connect to MCP server, discover tools, register each as `{name}_{mcpToolName}`
  - `soat` → for each action, create tool that calls the platform MCP handler in-process, prefixed as `{name}_{action}`
- **`prepareStep`:** Use the `ai` package's `prepareStep` callback to apply step rules, active tools, and tool choice per step.
- **`stopWhen`:** Map `stopConditions` to the `ai` package's `stopWhen` (e.g., `hasToolCall(toolName)`).
- **Client tool pause:** When the model calls a client tool, store the generation state (in-memory or DB) keyed by `generationId`, return `requires_action` response.
- **`remainingDepth`:** On `createGeneration`, convert `maxCallDepth` → `remainingDepth`. When a `soat` tool triggers `create-agent-generation`, pass `remainingDepth - 1`. Reject if `remainingDepth === 0`.
- **Trace:** On top-level generation, create a `traceId`. Pass it internally to all child generations.
- **Boundary policy:** Before executing a `soat` action, evaluate `callerIsAllowed(action) AND agentBoundaryIsAllowed(action)`.

---

## Phase 4: REST API

### 4.1 Create Route Handlers

**File:** `packages/server/src/rest/v1/agents.ts`

Every handler must check `ctx.authUser` (401), call `isAllowed` (403), delegate to lib functions, and include an `@openapi` JSDoc block.

| Method   | Path                                                   | Permission                     | Lib Function        |
| -------- | ------------------------------------------------------ | ------------------------------ | ------------------- |
| `POST`   | `/agents`                                              | `agents:CreateAgent`           | `createAgent`       |
| `GET`    | `/agents`                                              | `agents:ListAgents`            | `listAgents`        |
| `GET`    | `/agents/:agentId`                                     | `agents:GetAgent`              | `getAgent`          |
| `PUT`    | `/agents/:agentId`                                     | `agents:UpdateAgent`           | `updateAgent`       |
| `DELETE` | `/agents/:agentId`                                     | `agents:DeleteAgent`           | `deleteAgent`       |
| `POST`   | `/agents/:agentId/generate`                            | `agents:CreateAgentGeneration` | `createGeneration`  |
| `POST`   | `/agents/:agentId/generate/:generationId/tool-outputs` | `agents:CreateAgentGeneration` | `submitToolOutputs` |
| `POST`   | `/agents/tools`                                        | `agents:CreateAgentTool`       | `createAgentTool`   |
| `GET`    | `/agents/tools`                                        | `agents:ListAgentTools`        | `listAgentTools`    |
| `GET`    | `/agents/tools/:toolId`                                | `agents:GetAgentTool`          | `getAgentTool`      |
| `PUT`    | `/agents/tools/:toolId`                                | `agents:UpdateAgentTool`       | `updateAgentTool`   |
| `DELETE` | `/agents/tools/:toolId`                                | `agents:DeleteAgentTool`       | `deleteAgentTool`   |
| `GET`    | `/agents/traces`                                       | `agents:ListAgentTraces`       | `listTraces`        |
| `GET`    | `/agents/traces/:traceId`                              | `agents:GetAgentTrace`         | `getTrace`          |

**Route ordering:** Mount `/agents/tools` and `/agents/traces` **before** `/agents/:agentId` to avoid the wildcard param matching `tools` and `traces` as an `agentId`.

### 4.2 Register Router

**File:** `packages/server/src/rest/v1/index.ts`

```ts
import { agentsRouter } from './agents';
v1Router.use(agentsRouter.routes());
```

### 4.3 OpenAPI Spec

**File:** `packages/server/src/rest/openapi/v1/agents.yaml`

Document all 15 endpoints with request/response schemas. Follow existing YAML patterns in the `openapi/v1/` directory.

### 4.4 Streaming

The `POST /agents/:agentId/generate` handler must support `stream: true`. When streaming:

- Set `Content-Type: text/event-stream`
- Use the `ai` package's `streamText` instead of `generateText`
- Pipe step outputs as SSE events

---

## Phase 5: MCP Tools

### 5.1 Create MCP Tool Definitions

**File:** `packages/server/src/mcp/tools/agents.ts`

Export `registerTools(server: McpServer)`. Register one tool per operation using `apiCall`:

| Tool Name                   | Method   | Path                                                            |
| --------------------------- | -------- | --------------------------------------------------------------- |
| `create-agent`              | `POST`   | `/api/v1/agents`                                                |
| `list-agents`               | `GET`    | `/api/v1/agents`                                                |
| `get-agent`                 | `GET`    | `/api/v1/agents/{agentId}`                                      |
| `update-agent`              | `PUT`    | `/api/v1/agents/{agentId}`                                      |
| `delete-agent`              | `DELETE` | `/api/v1/agents/{agentId}`                                      |
| `create-agent-generation`   | `POST`   | `/api/v1/agents/{agentId}/generate`                             |
| `submit-agent-tool-outputs` | `POST`   | `/api/v1/agents/{agentId}/generate/{generationId}/tool-outputs` |
| `create-agent-tool`         | `POST`   | `/api/v1/agents/tools`                                          |
| `list-agent-tools`          | `GET`    | `/api/v1/agents/tools`                                          |
| `get-agent-tool`            | `GET`    | `/api/v1/agents/tools/{toolId}`                                 |
| `update-agent-tool`         | `PUT`    | `/api/v1/agents/tools/{toolId}`                                 |
| `delete-agent-tool`         | `DELETE` | `/api/v1/agents/tools/{toolId}`                                 |
| `list-agent-traces`         | `GET`    | `/api/v1/agents/traces`                                         |
| `get-agent-trace`           | `GET`    | `/api/v1/agents/traces/{traceId}`                               |

### 5.2 Register in Index

**File:** `packages/server/src/mcp/tools/index.ts`

```ts
import { registerTools as registerAgentTools } from './agents';
// inside registerTools():
registerAgentTools(server);
```

---

## Phase 6: Tests

### 6.1 Unit / Integration Tests

**File:** `packages/server/tests/unit/tests/agents.test.ts`

Follow test patterns from `files.test.ts` / `users.test.ts`. Use `testClient`, `authenticatedTestClient`, `loginAs`.

#### Test Groups

**Agent Tools CRUD:**

- `POST /api/v1/agents/tools` — create each type (`http`, `client`, `mcp`, `soat`), 401, 403
- `GET /api/v1/agents/tools` — list, 401
- `GET /api/v1/agents/tools/:toolId` — get, 404, 401
- `PUT /api/v1/agents/tools/:toolId` — update, 404, 401, 403
- `DELETE /api/v1/agents/tools/:toolId` — delete, 404, 401, 403

**Agents CRUD:**

- `POST /api/v1/agents` — create with tool references, 401, 403
- `GET /api/v1/agents` — list, 401
- `GET /api/v1/agents/:agentId` — get, 404, 401
- `PUT /api/v1/agents/:agentId` — update, 404, 401, 403
- `DELETE /api/v1/agents/:agentId` — delete, 404, 401, 403

**Generation:**

- `POST /api/v1/agents/:agentId/generate` — happy path (mock AI response), 401, 403, 404
- Client tool pause → `requires_action` response shape
- `POST /api/v1/agents/:agentId/generate/:generationId/tool-outputs` — resume, 401, 403
- Streaming (`stream: true`) — verify SSE content type
- `remainingDepth` enforcement — nested calls respect the limit

**Boundary Policy:**

- Agent with `boundaryPolicy` blocks disallowed `soat` actions
- Caller without permission cannot escalate via agent

**Traces:**

- `GET /api/v1/agents/traces` — list, 401, 403
- `GET /api/v1/agents/traces/:traceId` — get, 404, 401, 403

#### Response Shape Assertions

- `id` is `agt_` / `agt_tool_` / `agt_gen_` prefixed (public ID, not internal)
- Sensitive fields absent (no internal DB `id`, no raw secrets)
- `status` field on generation responses: `completed` | `requires_action`

### 6.2 MCP Tool Tests

**File:** `packages/server/tests/unit/tests/mcp.test.ts`

Add tests for all 14 MCP tools. Follow existing `mcpCall` / `parseResult` patterns.

### 6.3 Run Tests

```bash
pnpm --filter @soat/server test --testPathPatterns=agents.test.ts
pnpm --filter @soat/server test --testPathPatterns=mcp.test.ts
```

---

## Phase 7: Smoke Test

### 7.1 Add Agent Lifecycle Steps

**File:** `tests/smoke-test.sh`

Add end-to-end steps:

1. Create an agent tool (`http` type)
2. Create an agent referencing the tool
3. Get the agent
4. Run a generation (mock or real AI provider)
5. List traces
6. Delete the agent
7. Delete the agent tool

---

## Implementation Order

Recommended order to minimize back-and-forth and keep the build green:

1. **Phase 1** — DB models + build postgresdb
2. **Phase 2** — Permissions
3. **Phase 3.1** — Agent Tool CRUD lib functions only (no generation yet)
4. **Phase 4.1** — Agent Tool CRUD REST routes + Agent CRUD REST routes
5. **Phase 3.2** — Agent CRUD lib functions
6. **Phase 6.1a** — Tests for Agent Tool + Agent CRUD (validate before generation)
7. **Phase 3.3** — Generation lib (core tool loop with `generateText`)
8. **Phase 4.4** — Generate endpoint + streaming
9. **Phase 3.4** — Client tool pause/resume, `submitToolOutputs`
10. **Phase 3.5** — SOAT tool type + boundary policy enforcement
11. **Phase 3.6** — `remainingDepth` + trace creation
12. **Phase 3.7** — Trace query functions
13. **Phase 4.1b** — Trace REST routes
14. **Phase 6.1b** — Tests for generation, boundary, traces
15. **Phase 5** — MCP tools
16. **Phase 6.2** — MCP tests
17. **Phase 4.3** — OpenAPI YAML
18. **Phase 7** — Smoke test
