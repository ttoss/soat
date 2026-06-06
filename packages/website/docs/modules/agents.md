import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agents

Persistent configurations for multi-step AI workflows that execute reasoning-and-acting loops.

## Overview

Agents differ from [Chats](./chats.md) in that they can call tools, observe results, and continue reasoning across multiple steps until they reach a final answer or a step limit. Each agent stores its AI provider, instructions, tool references, and execution parameters. To run an agent, send a prompt — the server builds the agent from the stored configuration, executes the full loop, and returns the result.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 4 (Create an agent)](/docs/tutorials/chat-with-llm#step-4--create-an-agent)
- [Agent SOAT Tools and Preset Parameters - Step 7 (Create the agent)](/docs/tutorials/agent-soat-tools#step-7--create-the-agent)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 6 (Create stanza agents)](/docs/tutorials/multi-agent-orchestration#step-6--create-the-four-stanza-agents)

## Data Model

### Agent

| Field                      | Type          | Description                                                                                                                      |
| -------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | string        | Unique identifier (`agt_` prefix)                                                                                                |
| `project_id`               | string        | Project the agent belongs to                                                                                                     |
| `ai_provider_id`           | string        | AI provider used for the model                                                                                                   |
| `name`                     | string        | Display name                                                                                                                     |
| `instructions`             | string        | System instructions guiding agent behavior                                                                                       |
| `model`                    | string        | Model identifier (falls back to AI provider default)                                                                             |
| `tool_ids`                 | array         | IDs of tools attached to this agent — see [Tools](./tools.md)                                                                   |
| `max_steps`                | number        | Maximum reasoning steps before stopping (default: `20`)                                                                          |
| `tool_choice`              | string/object | How the model selects tools — see [Tool Choice](#tool-choice)                                                                    |
| `stop_conditions`          | array         | Additional stop conditions — see [Stop Conditions](#stop-conditions)                                                             |
| `active_tool_ids`          | array         | Subset of `tool_ids` available at each step — see [Active Tools](#active-tools)                                                  |
| `step_rules`               | array         | Per-step overrides for `tool_choice` and `active_tool_ids` — see [Step Rules](#step-rules)                                       |
| `boundary_policy`          | object        | Boundary policy that limits which `soat` actions the agent can perform — see [SOAT Action Permissions](#soat-action-permissions) |
| `temperature`              | number        | Sampling temperature                                                                                                             |
| `knowledge_config`         | object        | Knowledge retrieval config injected before every generation — see [Knowledge Config](#knowledge-config)                          |
| `max_context_messages`     | number        | Maximum number of recent messages sent to the model per generation — see [Context Window Limiting](#context-window-limiting)     |
| `single_session_per_actor` | boolean       | When `true`, only one open session per `actor_id` is allowed — see [Single Session Per Actor](#single-session-per-actor)         |
| `created_at`               | string        | ISO 8601 creation timestamp                                                                                                      |
| `updated_at`               | string        | ISO 8601 last-updated timestamp                                                                                                  |

### Generation

A generation is a persisted lifecycle record for a single agent execution. While a [trace](./traces.md) captures _what happened_ (steps), a generation captures _the lifecycle_ (who started it, when it started/completed, and why it stopped).

| Field                     | Type        | Description                                             |
| ------------------------- | ----------- | ------------------------------------------------------- |
| `id`                      | string      | Public identifier (`agt_gen_` prefix)                   |
| `project_id`              | string      | Project the generation belongs to                       |
| `agent_id`                | string      | Agent that was executed                                 |
| `trace_id`                | string      | Associated trace ID — see [Traces](./traces.md)         |
| `initiator_generation_id` | string/null | Generation that spawned this one (for nested calls)     |
| `status`                  | string      | Current lifecycle state — see [Generation Status](#generation-status) |
| `started_at`              | string      | ISO 8601 timestamp when execution began                 |
| `completed_at`            | string/null | ISO 8601 timestamp when execution finished              |
| `last_activity_at`        | string/null | ISO 8601 timestamp of last step activity                |
| `stop_reason`             | string/null | Why the generation ended — see [Stop Reason](#stop-reason) |
| `started_by`              | object/null | Identity of the principal that triggered the generation |
| `created_at`              | string      | ISO 8601 creation timestamp                             |

#### Generation Status

| Status            | Description                                       |
| ----------------- | ------------------------------------------------- |
| `in_progress`     | The generation is actively running                |
| `requires_action` | Paused waiting for client tool outputs            |
| `completed`       | The generation finished                           |
| `failed`          | The generation encountered an unrecoverable error |

#### Stop Reason

When `status` is `completed`, `stop_reason` indicates why:

| Stop Reason               | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `end_turn`                | Model produced a final response with no tool calls |
| `max_steps`               | Step count reached `max_steps`                     |
| `stop_condition`          | A configured `stop_conditions` rule was triggered  |
| `no_executor`             | A tool without an executor was called (non-client) |
| `stream_response_started` | Streaming generation handed off to the SSE stream  |
| `depth_limit`             | Nested call exceeded `max_call_depth`              |

## Key Concepts

### Tools

Agents reference [Tools](./tools.md) by their IDs via the `tool_ids` field. A single tool can be attached to many agents. For tool types (`http`, `client`, `mcp`, `soat`), execution behavior, preset parameters, and tool name resolution, see the [Tools module](./tools.md).

`tool_choice` and `stop_conditions` reference tools by their **resolved name** (e.g., `github_create_issue`), not by ID. See [Tool Name Resolution](./tools.md#tool-name-resolution) in the Tools module.

### Instructions

The `instructions` field sets the agent's system prompt. It defines the agent's persona, capabilities, and constraints. When running a per-agent generation, you can include a `system` message in `messages` to override the stored instructions for that call only.

### AI Provider Resolution

The agent resolves its AI provider by `ai_provider_id`. The provider's secret is decrypted and used to authenticate with the upstream model API. If `model` is not set on the agent, the provider's `default_model` is used. See [AI Providers](./ai-providers.md).

### Tool Choice

The `tool_choice` field sets the **default** tool-selection strategy for every step. To override on specific steps, use [Step Rules](#step-rules).

| Value                                   | Behavior                                                 |
| --------------------------------------- | -------------------------------------------------------- |
| `"auto"` (default)                      | The model decides whether to call a tool or produce text |
| `"required"`                            | The model must call a tool at every step                 |
| `{ type: "tool", tool_name: "<name>" }` | The model must call the specified tool                   |

Using `"required"` is useful when combined with a tool that has no `execute` configuration (a "done" tool). The agent is forced to use tools at every step and stops when it calls the tool without an executor.

### Step Rules

The `step_rules` array lets you override `tool_choice` and `active_tool_ids` on specific steps. Each rule targets a step number (1-indexed).

| Field             | Type          | Required | Description                         |
| ----------------- | ------------- | -------- | ----------------------------------- |
| `step`            | number        | yes      | Step number (1-indexed)             |
| `tool_choice`     | string/object | no       | Override tool choice for this step  |
| `active_tool_ids` | array         | no       | Override active tools for this step |

Example — force `search` on step 1, then `analyze` on step 2:

```json
{
  "step_rules": [
    { "step": 1, "tool_choice": { "type": "tool", "tool_name": "search" } },
    { "step": 2, "tool_choice": { "type": "tool", "tool_name": "analyze" } }
  ]
}
```

For **dynamic** per-step control (when you don't know the plan in advance), use `client` tools as pause points. When submitting tool outputs, you can pass overrides at multiple levels:

| Field             | Scope                             | Description                                                                    |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `tool_choice`     | Next step only                    | Override tool choice for the immediate next step                               |
| `active_tool_ids` | Next step only                    | Override active tools for the immediate next step                              |
| `step_rules`      | Specific upcoming steps           | Array of `{ step, tool_choice?, active_tool_ids? }` targeting future steps     |
| `defaults`        | All remaining steps in generation | Object with `tool_choice` and/or `active_tool_ids` that replace agent defaults |

**Priority** (highest → lowest): next-step overrides → `step_rules` for that step → `defaults` → agent config.

### Stop Conditions

Besides `max_steps`, you can define additional stop conditions via the `stop_conditions` array. The loop stops when **any** condition is met.

| Condition                                      | Description                                  |
| ---------------------------------------------- | -------------------------------------------- |
| `{ type: "hasToolCall", tool_name: "<name>" }` | Stop when the model calls the specified tool |

Example — stop after the model calls a `done` tool **or** after 50 steps:

```json
{
  "max_steps": 50,
  "stop_conditions": [{ "type": "hasToolCall", "tool_name": "done" }]
}
```

### Active Tools

By default, all tools in `tool_ids` are available at every step. Use `active_tool_ids` to restrict which tools the model can see globally. For phased workflows where different steps need different tools, use [Step Rules](#step-rules) instead.

`active_tool_ids` must be a subset of `tool_ids`. If omitted, all tools in `tool_ids` are active.

### Generation Loop

Running an agent creates a **generation** — a single execution of the tool loop. The agent calls the model, checks if it wants to invoke a tool, executes the tool (if configured), and feeds the result back. This loop continues until:

- The model produces a final text response with no tool calls (unless `tool_choice` is `"required"`).
- The step count reaches `max_steps`.
- A stop condition in `stop_conditions` is met.
- A tool without an `execute` configuration is called (including `client` tools — which pause the generation instead of terminating it).

Use `POST /agents/{agent_id}/generate` to run a generation. The request accepts:

| Parameter         | Type          | Required | Description                                                                                                                                 |
| ----------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`          | string        | cond.    | Text prompt (must provide `prompt` and/or `messages`)                                                                                       |
| `messages`        | array         | cond.    | Message history (must provide `prompt` and/or `messages`). Each item uses `content`, which can be plain text, `tool_output`, or `document`. |
| `tool_choice`     | string/object | no       | Override the agent's `tool_choice` for this generation                                                                                      |
| `active_tool_ids` | array         | no       | Override the agent's `active_tool_ids` for this generation                                                                                  |
| `step_rules`      | array         | no       | Override the agent's `step_rules` for this generation                                                                                       |
| `stop_conditions` | array         | no       | Override the agent's `stop_conditions` for this generation                                                                                  |
| `max_call_depth`  | number        | no       | Maximum nesting depth for agent-to-agent calls (default: `10`)                                                                              |
| `stream`          | boolean       | no       | Stream results as Server-Sent Events                                                                                                        |
| `tool_context`    | object        | no       | Key-value pairs forwarded as `X-Soat-Context-*` headers on tool calls — see [Tool Context](#tool-context)                                   |

#### Tool Output Message Content

`messages[].content` can be a plain string, a `tool_output` object, or a `document` object.

When `content.type` is `tool_output`, the server executes the referenced tool before model inference and replaces the message content with the extracted result. Use this when user input must be transformed first (e.g., audio URL → transcription text).

```json
{
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "tool_output",
        "tool_id": "tool_audio_to_text",
        "input": { "url": "https://example.com/audio.mp3" },
        "output_path": ".data.transcription.text"
      }
    }
  ]
}
```

`tool_id` is required. `output_path` is optional — a jq expression that selects a value from the tool result. If omitted, the entire tool output is used as the message content. For tools that expose multiple actions (`soat`, `mcp`), provide `action` as well.

Useful jq patterns:

- Select nested property: `.data.transcription.text`
- Filter array items: `.items[] | select(.lang == "pt-BR") | .text`
- Fallback values: `.text // .data.text // ""`
- Transform and join: `.segments | map(.text) | join(" ")`

When `content.type` is `document`, the server loads the referenced document and uses its content as the message content:

```json
{
  "messages": [
    {
      "role": "user",
      "content": { "type": "document", "document_id": "doc_abc123" }
    }
  ]
}
```

### Streaming

Pass `stream: true` to receive results as Server-Sent Events (SSE). Each step's output is streamed as it is generated.

### Tool Context

`tool_context` lets callers inject key-value pairs forwarded as HTTP headers to every tool call in a generation. This enables server-side tools to perform authorization decisions based on the caller's identity without trusting data embedded in the prompt.

`tool_context` is a flat `Record<string, string>`. Each key is title-cased and prefixed with `X-Soat-Context-`:

| `tool_context` key | Forwarded header          |
| ------------------ | ------------------------- |
| `userId`           | `X-Soat-Context-UserId`   |
| `tenantId`         | `X-Soat-Context-TenantId` |

| Tool type | Context headers forwarded | Notes                                                     |
| --------- | ------------------------- | --------------------------------------------------------- |
| `http`    | Yes                       | Injected as request headers                               |
| `mcp`     | Yes                       | Injected as request headers on the MCP `tools/call` fetch |
| `soat`    | Yes                       | Propagated into nested agent generations                  |
| `client`  | No                        | Executes on the caller's side                             |

Context headers are injected **after** any headers configured on the tool definition. When a generation pauses with `status: "requires_action"`, the `tool_context` from the original request is preserved and automatically reapplied on resume.

### Context Window Limiting

Set `max_context_messages` to cap how many recent messages are sent to the model per generation. Only the last N messages are included; older messages are dropped from that generation's context (the full history is still stored).

```json
{ "max_context_messages": 20 }
```

When `null` (default), all messages are included.

### Single Session Per Actor

When `single_session_per_actor` is `true`, the server enforces that only one open session per `actor_id` exists at a time for that agent. A second `POST /agents/:id/sessions` with the same `actor_id` returns `409 Conflict` with error code `SINGLE_SESSION_CONFLICT` and `meta.session_id` pointing to the existing session.

```json
{
  "error": {
    "code": "SINGLE_SESSION_CONFLICT",
    "message": "An open session already exists for this actor.",
    "meta": { "session_id": "sess_..." }
  }
}
```

Requests without an `actor_id` are not affected. Closing or deleting the existing session allows a new one to be created.

### Knowledge Config

An agent can automatically retrieve relevant knowledge before every generation by setting `knowledge_config`. The server embeds the latest user message, runs a unified knowledge search, and injects matching results as system messages.

| Field            | Type       | Description                                                                                 |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `memory_ids`     | `string[]` | Search entries within these specific memories (`mem_` prefix)                               |
| `memory_tags`    | `string[]` | Search entries in memories whose tags match any of these patterns (glob supported: `user*`) |
| `document_ids`   | `string[]` | Scope document results to these specific document IDs                                       |
| `document_paths` | `string[]` | Scope document results to files under these path prefixes                                   |
| `min_score`      | `number`   | Minimum relevance score (0–1) for results to be included (default: 0.5)                     |
| `limit`          | `number`   | Maximum number of results to inject (default: 5)                                            |
| `write_memory_id`| `string`   | When set, automatically injects a `write_memory` tool that writes facts to this memory      |

The per-generation `knowledge_config` is merged with the agent's stored config. Arrays are **unioned**; scalars use the per-generation value when present. See [Memories](./memories.md#agent-integration) for details on how the `write_memory` tool works.

Results are injected as system messages prepended to the conversation:

```
[Document: /reports/q1.txt] Q1 revenue was $4.2M across all regions.
[Memory: Customer Preferences] Customer prefers email over phone calls.
```

### SOAT Action Permissions

When an agent executes a `soat` tool action, two policies are evaluated — both must allow the action:

1. **Caller policy** — the permissions of the user or API key that triggered the generation.
2. **Agent boundary policy** — an optional `boundary_policy` stored on the agent itself.

The effective permission is the intersection of the two:

```
effective = callerIsAllowed(action) AND agentBoundaryIsAllowed(action)
```

This follows the same pattern as [API keys](./api-keys.md#permission-inheritance) — the agent creator scopes what the agent can do at most. A caller can never use an agent to exceed their own permissions. If `boundary_policy` is omitted, only the caller's permissions apply.

The boundary policy only governs `soat` actions. For `http`, `client`, and `mcp` tools the actions execute externally and are outside the platform's permission model.

Example — agent restricted to reading and searching documents regardless of caller permissions:

```json
{
  "boundary_policy": {
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

### Nested Agent Calls

An agent can invoke another agent through a `soat` tool action (`create-agent-generation`). The server enforces a **maximum call depth** controlled by `max_call_depth` on the generate request (default: **10**). Each nested generation receives `remaining_depth - 1`. When `remaining_depth` reaches `0`, the call returns an error instead of spawning the child generation.

For observability, every generation creates its own **trace** linked to the parent via `parent_trace_id` and the shared `root_trace_id`. The child's `trace_id` appears in the parent's step data, making the full call graph reconstructable. See [Traces](./traces.md#trace-ancestry-model) for the ancestry model, invariants, and tree traversal.

### Generation Endpoints

#### List Generations

```
GET /api/v1/agents/generations?project_id=proj_ABC&agent_id=agt_01&status=in_progress&limit=20&offset=0
```

Query parameters: `project_id`, `agent_id`, `status`, `limit` (default: 50), `offset` (default: 0).

#### Get Generation

```
GET /api/v1/agents/generations/{generation_id}
```

#### Monitoring Running Generations

```
GET /api/v1/agents/generations?status=in_progress&project_id=proj_ABC
```

## Examples

### Create an agent

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent \
  --project-id proj_ABC \
  --name "My Agent" \
  --ai-provider-id aip_01 \
  --instructions "You are a helpful assistant."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.agents.createAgent({
  body: {
    project_id: 'proj_ABC',
    name: 'My Agent',
    ai_provider_id: 'aip_01',
    instructions: 'You are a helpful assistant.',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/agents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "My Agent",
    "ai_provider_id": "aip_01",
    "instructions": "You are a helpful assistant."
  }'
```

</TabItem>
</Tabs>

### Run a generation

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation \
  --agent-id agt_01 \
  --prompt "What is the capital of France?"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.agents.createAgentGeneration({
  path: { agent_id: 'agt_01' },
  body: { prompt: 'What is the capital of France?' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/agents/agt_01/generate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the capital of France?"}'
```

</TabItem>
</Tabs>

## Example Flows

### 1. Fully Automatic (server-side tools only)

**Use when:** all tools are `http` and the model should decide what to do on its own.

```json
{
  "ai_provider_id": "aip_openai",
  "instructions": "You are a research assistant.",
  "tool_ids": ["tool_k8x2f3np", "tool_m3p9qw7j"],
  "max_steps": 10
}
```

No `tool_choice`, `step_rules`, or `stop_conditions` — everything defaults to `"auto"`.

---

### 2. Client Tools (caller executes tools locally)

**Use when:** the tool needs access to the caller's environment (local files, browser, private APIs).

```json
{
  "ai_provider_id": "aip_openai",
  "instructions": "You help users analyze local data files.",
  "tool_ids": ["tool_r7w4n1hc", "tool_j5v1d6yt"],
  "max_steps": 10
}
```

When the model calls the `client` tool, the generation suspends with `status: "requires_action"`. The caller submits results via `POST /agents/{agent_id}/generate/{generation_id}/tool-outputs` and the loop resumes. See [client tools](./tools.md#client) for the full interaction pattern.

---

### 3. Structured Pipeline (Step Rules)

**Use when:** you know the exact sequence of tools the agent should follow.

```json
{
  "ai_provider_id": "aip_openai",
  "tool_ids": ["tool_e2h6t0bx", "tool_n9c3y8ms", "tool_p4s8a2kd"],
  "max_steps": 5,
  "step_rules": [
    { "step": 1, "tool_choice": { "type": "tool", "tool_name": "extract" } },
    { "step": 2, "tool_choice": { "type": "tool", "tool_name": "transform" } },
    { "step": 3, "tool_choice": { "type": "tool", "tool_name": "summarize" } }
  ]
}
```

---

### 4. Done Tool Pattern (forced structured output)

**Use when:** the model should always commit its final answer through a structured tool.

```json
{
  "ai_provider_id": "aip_openai",
  "instructions": "Research the topic and call done with your structured answer.",
  "tool_ids": ["tool_k8x2f3np", "tool_q6b2x5wf"],
  "tool_choice": "required",
  "stop_conditions": [{ "type": "hasToolCall", "tool_name": "done" }],
  "max_steps": 15
}
```

`tool_choice: "required"` forces the model to always call a tool. The `hasToolCall` stop condition fires when the model calls `done`, terminating the loop with structured output.

---

### 5. MCP Tools (tools from an MCP server)

**Use when:** you want the agent to use tools provided by an external MCP server (e.g., GitHub, Slack).

```json
{
  "ai_provider_id": "aip_anthropic",
  "instructions": "You manage GitHub repositories.",
  "tool_ids": ["tool_c5n8f2vb"],
  "max_steps": 10
}
```

`tool_c5n8f2vb` is an `mcp` tool connected to a GitHub MCP server. At generation time, the server discovers all available tool names from the MCP server and registers them with the model. See [mcp tools](./tools.md#mcp).

---

### 6. SOAT Tools (platform actions)

**Use when:** the agent needs to interact with SOAT platform data — reading documents, searching files, managing conversations.

```json
{
  "ai_provider_id": "aip_openai",
  "instructions": "You are a knowledge assistant. Use the project's documents to answer user questions.",
  "tool_ids": ["tool_s2d7p4qx"],
  "max_steps": 10
}
```

`tool_s2d7p4qx` is a `soat` tool with `"name": "docs"` and `"actions": ["search-documents", "get-document"]`. The model sees `docs_search-documents` and `docs_get-document` as tool names. See [soat tools](./tools.md#soat) and [preset parameters](./tools.md#preset-parameters).
