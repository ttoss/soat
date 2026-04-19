# Agents

## Overview

Agents are persistent configurations for multi-step AI workflows. Unlike simple chat completions that make a single model call, agents execute **reasoning-and-acting loops**: the model can call tools, observe results, and continue reasoning until it reaches a final answer or hits a step limit.

Each agent stores its AI provider, instructions, tool references, and execution parameters. To run an agent, send a prompt (and optional message history) — the server builds the agent from the stored configuration, executes the full loop, and returns the result.

## Key Concepts

### Agent Resource

| Field            | Type          | Required | Description                                                                                                                      |
| ---------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string        | auto     | Unique identifier (`agt_` prefix)                                                                                                |
| `projectId`      | string        | yes      | Project the agent belongs to                                                                                                     |
| `aiProviderId`   | string        | yes      | AI provider used for the model                                                                                                   |
| `name`           | string        | no       | Display name                                                                                                                     |
| `instructions`   | string        | no       | System instructions guiding agent behavior                                                                                       |
| `model`          | string        | no       | Model identifier (falls back to AI provider default)                                                                             |
| `toolIds`        | array         | no       | IDs of agent tools attached to this agent                                                                                        |
| `maxSteps`       | number        | no       | Maximum reasoning steps before stopping (default: `20`)                                                                          |
| `toolChoice`     | string/object | no       | How the model selects tools — see [Tool Choice](#tool-choice)                                                                    |
| `stopConditions` | array         | no       | Additional stop conditions — see [Stop Conditions](#stop-conditions)                                                             |
| `activeToolIds`  | array         | no       | Subset of `toolIds` available at each step — see [Active Tools](#active-tools)                                                   |
| `stepRules`      | array         | no       | Per-step overrides for `toolChoice` and `activeToolIds` — see [Step Rules](#step-rules)                                          |
| `boundaryPolicy` | object        | no       | Boundary policy that limits which `soat` actions the agent can perform — see [SOAT Action Permissions](#soat-action-permissions) |
| `temperature`    | number        | no       | Sampling temperature                                                                                                             |

### Agent Tool

Agent tools are reusable tool definitions that can be shared across multiple agents. Each tool is its own resource with a dedicated CRUD API.

| Field             | Type   | Required | Description                                                                       |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `id`              | string | auto     | Unique identifier (`agt_tool_` prefix)                                            |
| `projectId`       | string | yes      | Project the tool belongs to                                                       |
| `type`            | string | yes      | `http`, `client`, `mcp`, or `soat` (default: `"http"`)                            |
| `name`            | string | yes      | Tool name (`http`/`client`) or namespace prefix for the connection (`mcp`/`soat`) |
| `description`     | string | no       | What the tool does (sent to the model for selection)                              |
| `parameters`      | object | cond.    | JSON Schema for the tool's input — required for `http` and `client`               |
| `execute`         | object | cond.    | Execution configuration — required when `type` is `http`                          |
| `execute.url`     | string | yes      | HTTP endpoint called to execute the tool                                          |
| `execute.method`  | string | no       | HTTP method to use (default: `POST`). For `GET`, `HEAD`, or `DELETE` the tool arguments are appended as query-string parameters instead of a request body. |
| `execute.headers` | object | no       | Additional headers sent with the execution request                                |
| `mcp`             | object | cond.    | MCP server configuration — required when `type` is `mcp`                          |
| `mcp.url`         | string | yes      | URL of the MCP server (SSE or Streamable HTTP transport)                          |
| `mcp.headers`     | object | no       | Additional headers sent when connecting to the MCP server                         |
| `actions`         | array  | cond.    | List of SOAT platform actions to expose — required when `type` is `soat`          |

Agents reference tools by their IDs via the `toolIds` field. A single tool can be attached to many agents.

#### Tool ID vs Tool Name

A **tool ID** is the auto-generated resource identifier (e.g., `agt_tool_k8x2f3np`). It is used in `toolIds`, `activeToolIds`, and `stepRules[].activeToolIds`.

A **tool name** is the name the AI model sees at runtime (e.g., `"search"`). For `http` and `client` tools, one tool ID → one tool name (the `name` field). For `mcp` and `soat` tools, one tool ID → **many** tool names discovered from the MCP server or the platform’s action registry. See [Tool Name Resolution](#tool-name-resolution) for details.

`toolChoice` and `stopConditions` reference tools by **name** (not by ID).

#### Tool Types

The `type` field is required at creation time and defaults to `"http"`. Supported types: `http`, `client`, `mcp`, and `soat`.

##### http

When the model decides to call a tool, the server sends an HTTP request to the configured `execute.url` using the method specified in `execute.method` (defaults to `POST`). For `POST`, `PUT`, and `PATCH` requests the tool arguments are sent as a JSON body. For `GET`, `HEAD`, and `DELETE` requests the tool arguments are appended as query-string parameters.

##### client

The tool is registered with `description` and `parameters` but has **no server-side `execute`**. When the model calls a `client` tool the generation **pauses** and returns the pending tool calls to the API caller. The caller executes the tool locally, then sends the results back to continue the loop.

Client tool flow:

1. The caller starts a generation (`POST /agents/{agentId}/generate`).
2. The agent loop runs normally — `http` tools execute on the server.
3. When the model calls a `client` tool, the server **cannot** execute it. The generation suspends and responds with `status: "requires_action"` plus the pending tool calls.
4. The caller inspects the tool calls, runs them locally, and submits the results via `POST /agents/{agentId}/generate/{generationId}/tool-outputs`.
5. The server resumes the loop from where it left off, feeding the submitted tool results back to the model.
6. Steps 2–5 repeat until the loop terminates normally (final text, `maxSteps`, or a stop condition).

Example response when a client tool is called:

```json
{
  "status": "requires_action",
  "generationId": "agt_gen_abc123",
  "requiredAction": {
    "type": "submit_tool_outputs",
    "toolCalls": [
      {
        "toolCallId": "call_xyz",
        "toolName": "read_local_file",
        "arguments": { "path": "/tmp/data.csv" }
      }
    ]
  }
}
```

Submitting tool outputs:

```json
POST /agents/{agentId}/generate/{generationId}/tool-outputs

{
  "toolOutputs": [
    {
      "toolCallId": "call_xyz",
      "output": "col1,col2\n1,2\n3,4"
    }
  ]
}
```

The response has the same shape as a normal generation — either a final result or another `requires_action` if the model calls more client tools.

##### mcp

The tool represents a connection to an [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server. At generation time, the SOAT server connects to the MCP endpoint, discovers all available tools, and registers them with the AI model. One MCP tool ID provides **many** tool names — you only configure the connection, and each discovered tool's name, description, and parameters come from the MCP server.

MCP tools execute on the MCP server side. The SOAT server acts as a proxy: it receives the model's tool call, forwards it to the MCP server, and feeds the result back into the loop.

##### soat

The tool exposes actions from the SOAT platform itself (documents, conversations, files, secrets, etc.). Instead of pointing to an external endpoint, you list the platform actions the agent is allowed to use via the `actions` array. Each action name corresponds to an existing MCP tool registered on the platform (e.g., `get-document`, `search-documents`, `create-file`). The server executes these actions in-process, reusing the same permission checks as the REST API.

Available actions come from the platform's registered MCP tools: actors, ai-providers, chats, conversations, documents, files, projects, and secrets.

#### Tool Name Resolution

Since `mcp` and `soat` tools can expose **many** tool names from a single Agent Tool ID, the model needs a way to distinguish tools that may share the same name across different sources. Tool names are resolved as follows:

| Tool Type | Name the model sees    | Example                                              |
| --------- | ---------------------- | ---------------------------------------------------- |
| `http`    | `{name}`               | `search`                                             |
| `client`  | `{name}`               | `read_local_file`                                    |
| `mcp`     | `{name}_{mcpToolName}` | `github_create_issue`, `github_list_repos`           |
| `soat`    | `{name}_{action}`      | `platform_get_document`, `platform_search_documents` |

For `http` and `client` tools, the `name` field is used directly — each Agent Tool maps to exactly one tool name.

For `mcp` tools, the Agent Tool's `name` is used as a **prefix** joined with an underscore to each tool name discovered from the MCP server. This guarantees uniqueness even when two MCP servers expose tools with the same name (e.g., `github_search` vs `jira_search`).

For `soat` tools, the same convention applies — the `name` prefix is joined with each action name from the `actions` array.

`toolChoice` and `stopConditions` reference tools by their **resolved** name (e.g., `github_create_issue`, not just `create_issue`).

### Instructions

The `instructions` field sets the agent's system prompt. It defines the agent's persona, capabilities, and constraints. When running a per-agent generation, you can include a `system` message in `messages` to override the stored instructions for that call only.

### AI Provider Resolution

Same as chats — the agent resolves its AI provider by `aiProviderId`. The provider's secret is decrypted and used to authenticate with the upstream model API. If `model` is not set on the agent, the provider's `defaultModel` is used.

### Tool Choice

The `toolChoice` field sets the **default** tool-selection strategy for every step. To override on specific steps, use [Step Rules](#step-rules).

| Value                                  | Behavior                                                 |
| -------------------------------------- | -------------------------------------------------------- |
| `"auto"` (default)                     | The model decides whether to call a tool or produce text |
| `"required"`                           | The model must call a tool at every step                 |
| `{ type: "tool", toolName: "<name>" }` | The model must call the specified tool                   |

Using `"required"` is useful when combined with a tool that has no `execute` configuration (a "done" tool). The agent is forced to use tools at every step and stops when it calls the tool without an executor.

### Step Rules

The `stepRules` array lets you control `toolChoice` and `activeToolIds` on specific steps. Each rule targets a step number (1-indexed) and overrides the agent defaults for that step only.

| Field           | Type          | Required | Description                         |
| --------------- | ------------- | -------- | ----------------------------------- |
| `step`          | number        | yes      | Step number (1-indexed)             |
| `toolChoice`    | string/object | no       | Override tool choice for this step  |
| `activeToolIds` | array         | no       | Override active tools for this step |

Example — force `search` on step 1, then `analyze` on step 2, then let the model decide:

```json
{
  "stepRules": [
    { "step": 1, "toolChoice": { "type": "tool", "toolName": "search" } },
    {
      "step": 2,
      "toolChoice": { "type": "tool", "toolName": "analyze" },
      "activeToolIds": ["agt_tool_j5v1d6yt", "agt_tool_h2t9e3ul"]
    }
  ]
}
```

Steps without a matching rule use the agent's default `toolChoice` and `activeToolIds`.

For **dynamic** per-step control (when you don't know the plan in advance), use `client` tools to create pause points. When submitting tool outputs, you can pass overrides at three levels:

| Field           | Scope                             | Description                                                                 |
| --------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `toolChoice`    | Next step only                    | Override tool choice for the immediate next step                            |
| `activeToolIds` | Next step only                    | Override active tools for the immediate next step                           |
| `stepRules`     | Specific upcoming steps           | Array of `{ step, toolChoice?, activeToolIds? }` targeting future steps     |
| `defaults`      | All remaining steps in generation | Object with `toolChoice` and/or `activeToolIds` that replace agent defaults |

```json
POST /agents/{agentId}/generate/{generationId}/tool-outputs

{
  "toolOutputs": [
    { "toolCallId": "call_xyz", "output": "result" }
  ],
  "toolChoice": { "type": "tool", "toolName": "summarize" },
  "activeToolIds": ["agt_tool_p4s8a2kd"],
  "stepRules": [
    { "step": 5, "toolChoice": "auto" },
    { "step": 6, "toolChoice": { "type": "tool", "toolName": "transform" } }
  ],
  "defaults": {
    "toolChoice": "required",
    "activeToolIds": ["agt_tool_p4s8a2kd", "agt_tool_n9c3y8ms"]
  }
}
```

**Priority** (highest → lowest): next-step overrides (`toolChoice`/`activeToolIds`) → `stepRules` for that step → `defaults` → agent config.

### Stop Conditions

Besides `maxSteps`, you can define additional stop conditions via the `stopConditions` array. The loop stops when **any** condition is met.

| Condition                                     | Description                                  |
| --------------------------------------------- | -------------------------------------------- |
| `{ type: "hasToolCall", toolName: "<name>" }` | Stop when the model calls the specified tool |

Example — stop after the model calls a `done` tool **or** after 50 steps:

```json
{
  "maxSteps": 50,
  "stopConditions": [{ "type": "hasToolCall", "toolName": "done" }]
}
```

### Active Tools

By default, all tools in `toolIds` are available at every step. Use `activeToolIds` to restrict which tools the model can see globally. For phased workflows where different steps need different tools, use [Step Rules](#step-rules) instead.

`activeToolIds` must be a subset of `toolIds`. If omitted, all tools in `toolIds` are active.

### Generation

Running an agent creates a **generation** — a single execution of the tool loop. The agent calls the model, checks if it wants to invoke a tool, executes the tool (if configured), and feeds the result back. This loop continues until:

- The model produces a final text response with no tool calls (unless `toolChoice` is `"required"`).
- The step count reaches `maxSteps`.
- A stop condition in `stopConditions` is met.
- A tool without an `execute` configuration is called (including `client` tools — which pause the generation instead of terminating it).

Use `POST /agents/{agentId}/generate` to run a generation. It accepts `prompt` (string) and/or `messages` (array) as input. You can also pass `toolChoice`, `activeToolIds`, `stepRules`, `stopConditions`, and `maxCallDepth` to override the agent defaults for that request.

| Parameter        | Type          | Required | Description                                                                                                    |
| ---------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `prompt`         | string        | cond.    | Text prompt (must provide `prompt` and/or `messages`)                                                          |
| `messages`       | array         | cond.    | Message history (must provide `prompt` and/or `messages`)                                                      |
| `toolChoice`     | string/object | no       | Override the agent's `toolChoice` for this generation                                                          |
| `activeToolIds`  | array         | no       | Override the agent's `activeToolIds` for this generation                                                       |
| `stepRules`      | array         | no       | Override the agent's `stepRules` for this generation                                                           |
| `stopConditions` | array         | no       | Override the agent's `stopConditions` for this generation                                                      |
| `maxCallDepth`   | number        | no       | Maximum nesting depth for agent-to-agent calls (default: `10`) — see [Nested Agent Calls](#nested-agent-calls) |
| `stream`         | boolean       | no       | Stream results as Server-Sent Events                                                                           |

### Streaming

Pass `stream: true` to receive results as Server-Sent Events (SSE). Each step's output is streamed as it is generated.

## Example Flows

### 1. Fully Automatic (server-side tools only)

**Use when:** all tools are `http` and the model should decide what to do on its own.

**Setup:**

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "You are a research assistant.",
  "toolIds": ["agt_tool_k8x2f3np", "agt_tool_m3p9qw7j"],
  "maxSteps": 10
}
```

Where `agt_tool_k8x2f3np` → `"search"` (http) and `agt_tool_m3p9qw7j` → `"fetch_url"` (http).

No `toolChoice`, `stepRules`, or `stopConditions` — everything defaults to `"auto"`.

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate` with `{ "prompt": "Summarize the latest news on AI regulation" }`.
2. The model decides to call `search` → server POSTs to the tool's `execute.url` → result fed back.
3. The model decides to call `fetch_url` → server executes → result fed back.
4. The model produces a final text summary → generation complete.
5. Caller receives `{ "status": "completed", "text": "..." }`.

---

### 2. Client Tools (caller executes tools locally)

**Use when:** the tool needs access to the caller's environment (local files, browser, private APIs).

**Setup:**

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "You help users analyze local data files.",
  "toolIds": ["agt_tool_r7w4n1hc", "agt_tool_j5v1d6yt"],
  "maxSteps": 10
}
```

Where `agt_tool_r7w4n1hc` → `"read_file"` (client) and `agt_tool_j5v1d6yt` → `"analyze"` (http).

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate` with `{ "prompt": "Analyze /tmp/sales.csv" }`.
2. The model calls `read_file` → server has no `execute` for it → generation **pauses**.
3. Caller receives:
   ```json
   {
     "status": "requires_action",
     "generationId": "agt_gen_abc",
     "requiredAction": {
       "type": "submit_tool_outputs",
       "toolCalls": [
         {
           "toolCallId": "call_1",
           "toolName": "read_file",
           "arguments": { "path": "/tmp/sales.csv" }
         }
       ]
     }
   }
   ```
4. Caller reads the file locally and submits: `POST /agents/{agentId}/generate/agt_gen_abc/tool-outputs` with `{ "toolOutputs": [{ "toolCallId": "call_1", "output": "date,amount\n..." }] }`.
5. The model calls `analyze` (http) → server executes → result fed back.
6. The model produces final text → `{ "status": "completed", "text": "Sales grew by 15%..." }`.

---

### 3. Structured Pipeline (Step Rules)

**Use when:** you know the exact sequence of tools the agent should follow.

**Setup:**

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "Extract data, transform it, then summarize.",
  "toolIds": ["agt_tool_e2h6t0bx", "agt_tool_n9c3y8ms", "agt_tool_p4s8a2kd"],
  "maxSteps": 5,
  "stepRules": [
    { "step": 1, "toolChoice": { "type": "tool", "toolName": "extract" } },
    { "step": 2, "toolChoice": { "type": "tool", "toolName": "transform" } },
    { "step": 3, "toolChoice": { "type": "tool", "toolName": "summarize" } }
  ]
}
```

Where `agt_tool_e2h6t0bx` → `"extract"`, `agt_tool_n9c3y8ms` → `"transform"`, `agt_tool_p4s8a2kd` → `"summarize"` (all http).

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate` with `{ "prompt": "Process order #1234" }`.
2. Step 1 — model is **forced** to call `extract` → server executes → result fed back.
3. Step 2 — model is **forced** to call `transform` → server executes → result fed back.
4. Step 3 — model is **forced** to call `summarize` → server executes → result fed back.
5. Step 4 — no rule → falls back to `"auto"` → model produces final text.

---

### 4. Dynamic Control (decide at runtime)

**Use when:** the next step depends on previous results and you can't plan the pipeline in advance.

**Setup:**

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "You are a coding assistant.",
  "toolIds": ["agt_tool_g1m7k4re", "agt_tool_w3f5r9aj", "agt_tool_d8j4v0zp"],
  "maxSteps": 20
}
```

Where `agt_tool_g1m7k4re` → `"search_code"` (http), `agt_tool_w3f5r9aj` → `"run_tests"` (http), `agt_tool_d8j4v0zp` → `"checkpoint"` (client — a pause point the caller uses to inspect intermediate results and steer the next step).

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate` with `{ "prompt": "Find and fix the failing test in auth.ts" }`.
2. The model calls `search_code` (http) → result fed back. Then calls `checkpoint` (client) → **pauses**.
3. Caller inspects the search results in the `requires_action` response and decides the model should run tests next, then search again. Submits tool outputs **with overrides at multiple levels**:
   ```json
   {
     "toolOutputs": [{ "toolCallId": "call_2", "output": "proceed" }],
     "toolChoice": { "type": "tool", "toolName": "run_tests" },
     "activeToolIds": ["agt_tool_w3f5r9aj"],
     "stepRules": [
       {
         "step": 4,
         "toolChoice": { "type": "tool", "toolName": "search_code" },
         "activeToolIds": ["agt_tool_g1m7k4re"]
       }
     ],
     "defaults": {
       "toolChoice": "required"
     }
   }
   ```
4. Step 3 — next-step override wins → model is **forced** to call `run_tests` → server executes → result fed back.
5. Step 4 — `stepRules` override wins → model is **forced** to call `search_code` → server executes → result fed back.
6. Step 5+ — no rule, no next-step override → `defaults` apply → `toolChoice: "required"` so the model must call a tool, but can choose which one.

---

### 5. Done Tool Pattern (forced termination)

**Use when:** the model should always "commit" its final answer through a structured tool instead of free-form text.

**Setup:**

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "Research the topic and call done with your structured answer.",
  "toolIds": ["agt_tool_k8x2f3np", "agt_tool_q6b2x5wf"],
  "toolChoice": "required",
  "stopConditions": [{ "type": "hasToolCall", "toolName": "done" }],
  "maxSteps": 15
}
```

Where `agt_tool_k8x2f3np` → `"search"` (http) and `agt_tool_q6b2x5wf` → `"done"` (client, no execute).

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate`.
2. `toolChoice: "required"` → the model **must** call a tool at every step. It cannot respond with free-form text.
3. The model calls `search` repeatedly gathering data.
4. When ready, the model calls `done` with structured arguments (e.g., `{ "title": "...", "summary": "..." }`).
5. The `hasToolCall` stop condition fires → loop terminates immediately.
6. Caller receives the generation result including the `done` tool's arguments as structured output.

---

### 6. MCP Tools (tools from an MCP server)

**Use when:** you want the agent to use tools provided by an external MCP server (e.g., GitHub, Slack, a custom internal service).

**Setup:**

```json
{
  "aiProviderId": "aip_anthropic",
  "instructions": "You manage GitHub repositories. Use the available tools to help the user.",
  "toolIds": ["agt_tool_c5n8f2vb"],
  "maxSteps": 10
}
```

Where `agt_tool_c5n8f2vb` is an `mcp` tool connected to a GitHub MCP server. At generation time, the server discovers tools like `search_repositories`, `create_issue`, `list_pull_requests`, `get_file_contents`, etc. — all from a single tool ID.

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate` with `{ "prompt": "Create an issue in acme/api titled 'Fix auth bug'" }`.
2. The server connects to the MCP endpoint configured on `agt_tool_c5n8f2vb`, discovers all available tool names, and registers them with the model.
3. The model decides to call `create_issue` → the server proxies the call to the MCP server → result fed back.
4. The model produces a final text confirmation → generation complete.
5. Caller receives `{ "status": "completed", "text": "Created issue #42 ..." }`.

You can combine MCP tools with `http` and `client` tools in the same agent — all tool names from all sources are available to the model.

---

### 7. SOAT Tools (platform actions)

**Use when:** the agent needs to interact with data on the SOAT platform itself — reading documents, searching files, managing conversations, etc.

**Setup:**

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "You are a knowledge assistant. Use the project’s documents to answer user questions.",
  "toolIds": ["agt_tool_s2d7p4qx"],
  "maxSteps": 10
}
```

Where `agt_tool_s2d7p4qx` is a `soat` tool configured as:

```json
{
  "type": "soat",
  "name": "docs",
  "actions": ["search-documents", "get-document"]
}
```

**What happens:**

1. Caller sends `POST /agents/{agentId}/generate` with `{ "prompt": "What does our API rate-limiting policy say?" }`.
2. The server registers two tools with the model: `docs_search_documents` and `docs_get_document` (names derived from `{name}_{action}`).
3. The model calls `docs_search_documents` with `{ "query": "rate limiting policy" }` → the server executes the `search-documents` action in-process → result fed back.
4. The model calls `docs_get_document` with `{ "id": "doc_abc" }` to get the full text → server executes → result fed back.
5. The model produces a final answer → generation complete.
6. Caller receives `{ "status": "completed", "text": "The rate-limiting policy states…" }`.

You can combine `soat` tools with `http`, `client`, and `mcp` tools in the same agent.

## SOAT Action Permissions

When an agent executes a `soat` tool action, the server must decide whether the action is allowed. Two policies are evaluated — both must allow the action for it to proceed:

1. **Caller policy** — the permissions of the user or API key that triggered the generation. This is the same policy evaluation used by every other REST endpoint.
2. **Agent boundary policy** — an optional `boundaryPolicy` stored on the agent itself that caps what the agent is allowed to do, regardless of who calls it.

The effective permission is the **intersection** of the two:

```
effective = callerIsAllowed(action) AND agentBoundaryIsAllowed(action)
```

This follows the same pattern as project API keys, where the key's policy intersects the user's policy.

### Why two layers?

- **Principle of least privilege** — the agent creator scopes what the agent can do at most. A document-search agent shouldn't be able to delete files even if the caller can.
- **Callers can't escalate** — a user with read-only permissions can't use an agent whose boundary allows writes to bypass their own restrictions.
- **No boundary = caller-only** — if `boundaryPolicy` is omitted, only the caller's permissions apply (backward compatible).

### Example

```json
{
  "aiProviderId": "aip_openai",
  "instructions": "You answer questions using project documents.",
  "toolIds": ["agt_tool_s2d7p4qx"],
  "boundaryPolicy": {
    "statement": [
      {
        "effect": "Allow",
        "action": ["documents:GetDocument", "documents:SearchDocuments"],
        "resource": ["*"]
      }
    ]
  }
}
```

Even if the caller has `documents:*` (full access), this agent can only read and search documents — never create or delete them.

### Scope

The boundary policy only governs `soat` actions, which execute against platform data. For `http`, `client`, and `mcp` tools the actions execute externally and are outside the platform's permission model.

## Nested Agent Calls

An agent can invoke another agent through a `soat` tool action (e.g., `create-agent-generation`). Without safeguards this can lead to unbounded recursion (`A→B→A→…`).

The server enforces a **maximum call depth** controlled by the `maxCallDepth` parameter on the generate request (default: **10**). Internally, the server converts this into a `remainingDepth` counter. Each time a `soat` action triggers a child generation, the child receives `remainingDepth - 1`. When `remainingDepth` reaches `0`, the action returns an error instead of spawning the child generation.

This design is self-contained: each generation only needs its own `remainingDepth` — it does not need to know the original `maxCallDepth` or any shared trace state.

For observability, every top-level generation also creates a **trace** identified by a unique `traceId` (`agt_trace_` prefix). The server attaches the same `traceId` to all generations in the chain automatically. This is internal server plumbing — agents do not receive or propagate `traceId`.

Example: A caller starts Agent A with `maxCallDepth: 3`. Agent A runs with `remainingDepth: 3` and calls Agent B (`remainingDepth: 2`). Agent B calls Agent C (`remainingDepth: 1`). Agent C can still run but cannot nest further — if it tries to call Agent D, `remainingDepth` would be `0` → the server rejects the call.

## Permissions

| Action               | Permission                     | REST Endpoint                                                 | MCP Tool                    |
| -------------------- | ------------------------------ | ------------------------------------------------------------- | --------------------------- |
| Create an agent      | `agents:CreateAgent`           | `POST /agents`                                                | `create-agent`              |
| List agents          | `agents:ListAgents`            | `GET /agents`                                                 | `list-agents`               |
| Get an agent         | `agents:GetAgent`              | `GET /agents/{agentId}`                                       | `get-agent`                 |
| Update an agent      | `agents:UpdateAgent`           | `PUT /agents/{agentId}`                                       | `update-agent`              |
| Delete an agent      | `agents:DeleteAgent`           | `DELETE /agents/{agentId}`                                    | `delete-agent`              |
| Run a generation     | `agents:CreateAgentGeneration` | `POST /agents/{agentId}/generate`                             | `create-agent-generation`   |
| Submit tool outputs  | `agents:CreateAgentGeneration` | `POST /agents/{agentId}/generate/{generationId}/tool-outputs` | `submit-agent-tool-outputs` |
| Create an agent tool | `agents:CreateAgentTool`       | `POST /agents/tools`                                          | `create-agent-tool`         |
| List agent tools     | `agents:ListAgentTools`        | `GET /agents/tools`                                           | `list-agent-tools`          |
| Get an agent tool    | `agents:GetAgentTool`          | `GET /agents/tools/{toolId}`                                  | `get-agent-tool`            |
| Update an agent tool | `agents:UpdateAgentTool`       | `PUT /agents/tools/{toolId}`                                  | `update-agent-tool`         |
| Delete an agent tool | `agents:DeleteAgentTool`       | `DELETE /agents/tools/{toolId}`                               | `delete-agent-tool`         |
| List traces          | `agents:ListAgentTraces`       | `GET /agents/traces`                                          | `list-agent-traces`         |
| Get a trace          | `agents:GetAgentTrace`         | `GET /agents/traces/{traceId}`                                | `get-agent-trace`           |
