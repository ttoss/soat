# PRD: Orchestration Module

## Status

**Phase 0 — Tools Module Extraction:** ❌ Not started
**Phase 1 — Linear pipelines:** ❌ Not started
**Phase 2 — Parallel & conditional:** ❌ Not started
**Phase 3 — Human gates & checkpointing:** ❌ Not started
**Phase 4 — Cycles & dynamic routing:** ❌ Not started

---

## Overview

The Orchestration module is the **declarative workflow execution layer** for SOAT. It allows users to define multi-step pipelines as directed graphs where each node is an execution unit — an agent, a programmatic tool call, a data transform, a human gate, or other node types — and edges define the flow of execution with optional conditions.

Unlike the existing multi-agent capability (agents calling agents via SOAT tools, which is LLM-driven and non-deterministic), orchestrations provide **deterministic control flow** with typed state and artifact passing between steps. The LLM is used for reasoning within agent nodes; the orchestration engine handles routing, parallelism, and coordination.

### Why Not Just Agent-to-Agent?

SOAT already supports multi-agent workflows via SOAT tools (agent A calls agent B as a tool). This works well for dynamic delegation but has key limitations:

| Limitation                              | Orchestration Solution                |
| --------------------------------------- | ------------------------------------- |
| LLM decides routing (non-deterministic) | Graph edges with explicit conditions  |
| Sequential only (one tool at a time)    | Parallel fan-out/fan-in               |
| No shared state between agents          | Typed state accumulator               |
| No structured artifact passing          | Output schemas + state mapping        |
| No checkpointing/resumability           | Checkpoint after each node            |
| No human gates                          | `human` node type pauses execution    |
| Every step requires LLM (expensive)     | `tool`/`transform` nodes are LLM-free |

---

## Key Concepts

### Orchestration (the graph)

An Orchestration is a reusable workflow definition — a directed graph of nodes and edges. It belongs to a project and can be instantiated into multiple runs.

### Orchestration Run (the execution)

A Run is a single execution of an orchestration. It tracks current state, active nodes, artifacts, and checkpoints. Runs can be paused (human gates), resumed, and inspected.

### Nodes

A node is a single execution unit in the graph. Each node type has different execution semantics:

| Type           | Execution                                       | LLM Required | Use Case                                   |
| -------------- | ----------------------------------------------- | :----------: | ------------------------------------------ |
| `agent`        | Run agent generation                            |      ✅      | Reasoning, analysis, creative work         |
| `tool`         | Call a tool programmatically                    |      ❌      | API calls, data fetching, CRUD operations  |
| `transform`    | Evaluate an expression on state                 |      ❌      | Data reshaping, filtering, mapping         |
| `knowledge`    | Search knowledge with params from state         |      ❌      | Context retrieval for downstream nodes     |
| `human`        | Pause execution, wait for input                 |      ❌      | Approval gates, review steps               |
| `condition`    | Evaluate expression, route to edges             |      ❌      | Branching without LLM                      |
| `loop`         | Iterate over collection, run sub-graph per item |      ❌      | Batch processing, map operations           |
| `webhook`      | Wait for or emit an external event              |      ❌      | Async integrations, event-driven pipelines |
| `delay`        | Schedule continuation after duration            |      ❌      | Rate limiting, polling intervals           |
| `memory_write` | Persist artifacts to memory                     |      ❌      | Knowledge accumulation                     |

### Edges

Edges connect nodes and define the execution flow. Each edge can have:

- **Condition** — An expression evaluated against state/artifacts to determine if the edge is active
- **Activation group** — Groups edges pointing to the same target for join semantics
- **Activation condition** — `all` (wait for every edge in group) or `any` (proceed on first)

### State

A typed JSON object that accumulates across the run. Each node can read from and write to state via input/output mappings. State is the shared "memory" of the orchestration — it replaces passing data through conversation messages.

### Artifacts

The structured output of each node. Artifacts are stored on the run and can be referenced by downstream nodes via state mappings. Unlike state (which is a single accumulator), artifacts are per-node and immutable once produced.

---

## Node Types — Detail

### `agent` Node

Runs an existing SOAT agent generation. The most powerful node type — uses an LLM for reasoning.

```jsonc
{
  "id": "analyze_risk",
  "type": "agent",
  "agent_id": "agt_risk_analyst",
  "input_mapping": {
    // State fields → injected as user message context
    "customer_data": "state.customer",
    "transaction_history": "state.transactions",
  },
  "output_mapping": {
    // Agent structured output → state fields
    "risk_score": "state.risk_score",
    "risk_factors": "state.risk_factors",
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "risk_score": { "type": "number" },
      "risk_factors": { "type": "array", "items": { "type": "string" } },
    },
  },
}
```

The agent receives a system message containing the mapped inputs from state. The agent's response is parsed according to `output_schema` (uses structured outputs / JSON mode). The parsed output is written to state via `output_mapping`.

### `tool` Node — Programmatic Tool Calls

Calls a tool from the **Tools module** directly without LLM involvement. Inputs are derived deterministically from state.

This is the key differentiator from agent-based execution: **no LLM decides whether to call the tool or what arguments to pass**. The orchestration engine resolves inputs from state and invokes the tool. The same tool definitions that agents use (HTTP, MCP, SOAT) are reused here — only the invocation mode differs (deterministic mapping vs. LLM-selected arguments).

```jsonc
{
  "id": "fetch_customer",
  "type": "tool",
  "tool_id": "tool_crm_api", // References a Tool from the Tools module
  "operation_id": "getCustomer", // For mcp/soat tools: specific operation
  "input_mapping": {
    // State fields → tool arguments
    "customer_id": "state.customer_id",
  },
  "output_mapping": {
    // Tool response → state fields
    "customer": "state.customer_data",
  },
}
```

**Why this matters:**

1. **Zero LLM cost** — A pipeline that fetches data from 5 APIs, transforms it, and then calls one agent for analysis costs 1 LLM call instead of 6.
2. **Deterministic** — Tool inputs are exactly what you map from state. No hallucinated arguments.
3. **Fast** — No LLM latency for deterministic operations.
4. **Testable** — Given the same state, the tool always receives the same arguments.
5. **Shared definitions** — The same `tool_` resource is used by agents (LLM-driven) and orchestrations (state-driven). Define once, use everywhere.

**Execution by tool type:**

| Tool Type | Resolution                                                                               | Example                             |
| --------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `http`    | Resolves tool by `tool_id`, constructs request from mapped inputs using `execute` config | Call external CRM API               |
| `mcp`     | Resolves tool by `tool_id` + `operation_id`, invokes via MCP client                      | Call connected MCP server           |
| `soat`    | Resolves tool by `tool_id` + `operation_id`, calls internal REST endpoint                | Create a document, search knowledge |

### `transform` Node

Pure data transformation on state. No external calls, no LLM — just reshaping data.

```jsonc
{
  "id": "filter_high_risk",
  "type": "transform",
  "expression": "state.transactions.filter(t => t.amount > 10000)",
  "output_mapping": {
    "result": "state.high_value_transactions",
  },
}
```

Expressions are evaluated in a sandboxed context with access to `state` and `artifacts`. Supports a safe subset of JavaScript expressions (no `eval`, no side effects, no imports).

### `knowledge` Node

Searches the knowledge module with parameters derived from state. Equivalent to calling `POST /api/v1/knowledge/search` but without LLM involvement.

```jsonc
{
  "id": "retrieve_context",
  "type": "knowledge",
  "input_mapping": {
    "query": "state.user_question",
    "memory_ids": "state.relevant_memories",
    "actor_ids": "state.actor_ids",
  },
  "output_mapping": {
    "results": "state.knowledge_context",
  },
}
```

### `human` Node

Pauses the orchestration run and waits for human input. Returns a `requires_action` status similar to client tools in agent generation.

```jsonc
{
  "id": "approve_publication",
  "type": "human",
  "prompt": "Review the generated article and approve or reject.",
  "input_mapping": {
    "article": "state.draft_article", // Shown to human as context
  },
  "output_mapping": {
    "decision": "state.approval_decision",
    "feedback": "state.human_feedback",
  },
  "options": ["approve", "reject", "revise"], // Optional: constrain human input
}
```

When a `human` node activates, the run transitions to `paused` status. The caller submits human input via `POST /api/v1/orchestrations/:id/runs/:runId/human-input`.

### `condition` Node

Evaluates an expression and activates specific outgoing edges based on the result. This is a pure routing node — it produces no artifacts and doesn't modify state.

```jsonc
{
  "id": "check_risk_level",
  "type": "condition",
  "expression": "state.risk_score > 0.7 ? 'high' : state.risk_score > 0.3 ? 'medium' : 'low'",
}
```

Outgoing edges reference the condition's output labels:

```jsonc
{ "from": "check_risk_level", "to": "escalate", "condition": "high" },
{ "from": "check_risk_level", "to": "standard_review", "condition": "medium" },
{ "from": "check_risk_level", "to": "auto_approve", "condition": "low" }
```

### `loop` Node

Iterates over a collection in state and runs a sub-graph (or single node) for each item. Implements the "map" pattern over collections.

```jsonc
{
  "id": "process_each_customer",
  "type": "loop",
  "collection": "state.customers", // Array to iterate over
  "item_variable": "current_customer", // Name for current item in sub-state
  "sub_graph": "orch_customer_analysis", // Orchestration ID to run per item (or inline nodes)
  "parallelism": 3, // Max concurrent iterations
  "output_mapping": {
    "results": "state.customer_analyses", // Collects outputs into array
  },
}
```

### `webhook` Node

Pauses the run and waits for an external event (webhook callback) or emits an event to an external system.

```jsonc
{
  "id": "wait_for_payment",
  "type": "webhook",
  "mode": "receive", // "receive" (wait) | "emit" (fire)
  "timeout": "PT24H", // ISO 8601 duration — max wait time
  "output_mapping": {
    "payload": "state.payment_confirmation",
  },
}
```

### `delay` Node

Pauses execution for a specified duration. Useful for rate limiting, polling patterns, or timed sequences.

```jsonc
{
  "id": "wait_before_retry",
  "type": "delay",
  "duration": "PT5M", // ISO 8601 duration
}
```

### `memory_write` Node

Persists content from state into a SOAT memory. Uses the existing write algorithm (deduplication, merge).

```jsonc
{
  "id": "store_findings",
  "type": "memory_write",
  "memory_id": "mem_research_findings",
  "input_mapping": {
    "content": "state.analysis_summary",
  },
}
```

---

## Data Model

### Tables

#### `Orchestration`

| Column        | Type    | Description                               |
| ------------- | ------- | ----------------------------------------- |
| `id`          | INTEGER | Internal PK                               |
| `publicId`    | STRING  | External ID (`orch_...`)                  |
| `projectId`   | INTEGER | FK → Project                              |
| `name`        | STRING  | Human-readable name                       |
| `description` | STRING  | Optional description                      |
| `nodes`       | JSONB   | Array of node definitions                 |
| `edges`       | JSONB   | Array of edge definitions                 |
| `stateSchema` | JSONB   | Optional JSON Schema for state validation |
| `inputSchema` | JSONB   | Schema for run inputs (initial state)     |
| `createdAt`   | DATE    |                                           |
| `updatedAt`   | DATE    |                                           |

#### `OrchestrationRun`

| Column            | Type    | Description                                             |
| ----------------- | ------- | ------------------------------------------------------- |
| `id`              | INTEGER | Internal PK                                             |
| `publicId`        | STRING  | External ID (`run_...`)                                 |
| `orchestrationId` | INTEGER | FK → Orchestration                                      |
| `projectId`       | INTEGER | FK → Project                                            |
| `status`          | ENUM    | `running`, `paused`, `completed`, `failed`, `cancelled` |
| `state`           | JSONB   | Current accumulated state                               |
| `activeNodes`     | JSONB   | Array of currently executing node IDs                   |
| `artifacts`       | JSONB   | Map of nodeId → output artifact                         |
| `error`           | JSONB   | Error info if status = `failed`                         |
| `traceId`         | STRING  | Root trace ID for observability                         |
| `input`           | JSONB   | Initial input provided at run creation                  |
| `output`          | JSONB   | Final output (terminal node artifact)                   |
| `startedAt`       | DATE    |                                                         |
| `completedAt`     | DATE    |                                                         |
| `createdAt`       | DATE    |                                                         |
| `updatedAt`       | DATE    |                                                         |

#### `OrchestrationCheckpoint`

| Column      | Type    | Description                          |
| ----------- | ------- | ------------------------------------ |
| `id`        | INTEGER | Internal PK                          |
| `runId`     | INTEGER | FK → OrchestrationRun                |
| `nodeId`    | STRING  | Node that just completed             |
| `state`     | JSONB   | State snapshot after node completion |
| `artifacts` | JSONB   | Artifacts snapshot                   |
| `createdAt` | DATE    |                                      |

---

## Execution Engine

### Algorithm

```
executeRun(run, orchestration):
  1. Initialize state from run.input (validated against orchestration.inputSchema)
  2. Determine start nodes (nodes with no incoming edges)
  3. Set run.activeNodes = startNodes
  4. WHILE activeNodes is not empty:
     a. Execute all activeNodes in parallel (respecting node-level parallelism limits)
     b. For each completed node:
        - Store artifact in run.artifacts[nodeId]
        - Apply outputMapping to state
        - Create checkpoint
     c. For each failed node:
        - If retryable, re-queue
        - Else, set run.status = 'failed', store error, exit
     d. For each human/webhook node:
        - Set run.status = 'paused', exit (will resume on external input)
     e. Resolve next nodes:
        - For each outgoing edge of completed nodes:
          - Evaluate condition (if any) against state
          - Check activation groups (all/any semantics)
        - Collect nodes whose all activation requirements are satisfied
     f. Set run.activeNodes = resolved next nodes
     g. If no next nodes and no paused nodes → run.status = 'completed'
  5. Set run.output = artifact of terminal node(s)
```

### Node Execution

Each node type has a dedicated executor:

```
executeNode(node, state, run):
  SWITCH node.type:
    case 'agent':
      - Build messages from inputMapping + state
      - Call createGeneration(agentId, messages, { structuredOutput: node.outputSchema })
      - Parse response, return artifact

    case 'tool':
      - Resolve tool definition (http/mcp/soat)
      - Map inputs from state → tool arguments
      - Execute tool call (reuse existing tool resolver infrastructure)
      - Return tool response as artifact

    case 'transform':
      - Evaluate expression in sandboxed context with { state, artifacts }
      - Return result as artifact

    case 'knowledge':
      - Map search params from state
      - Call searchKnowledge(params)
      - Return results as artifact

    case 'human':
      - Emit 'requires_action' event
      - Suspend (engine handles pause)
      - On resume: return human input as artifact

    case 'condition':
      - Evaluate expression against state
      - Return label (used by edge resolution, not stored as artifact)

    case 'loop':
      - Read collection from state
      - For each item (with parallelism limit):
        - Create sub-run or inline execution with item injected into sub-state
      - Collect results into array
      - Return array as artifact

    case 'webhook':
      - If mode = 'emit': POST payload to configured URL, return response
      - If mode = 'receive': suspend, wait for callback

    case 'delay':
      - Schedule wake-up after duration
      - Suspend

    case 'memory_write':
      - Read content from state via inputMapping
      - Call writeMemoryEntry({ memoryId, content })
      - Return write result as artifact
```

### Edge Resolution with Activation Groups

```
resolveNextNodes(edges, completedNodes, run):
  For each edge from a completed node:
    IF edge.condition exists:
      IF condition is a string label: match against condition node output
      IF condition is an expression: evaluate against state
      SKIP edge if condition is false

    Group edges by target node
    For each target node:
      Group incoming active edges by activationGroup
      For each group:
        IF activationCondition = 'all': target activates only if ALL edges in group are satisfied
        IF activationCondition = 'any': target activates if ANY edge in group is satisfied

  Return set of nodes that should activate
```

---

## REST API

All body fields use `snake_case` per project convention (external contract). Internal code uses `camelCase`.

### Orchestrations (CRUD)

| Method | Path                                       | Description                      |
| ------ | ------------------------------------------ | -------------------------------- |
| POST   | `/api/v1/orchestrations`                   | Create an orchestration          |
| GET    | `/api/v1/orchestrations`                   | List orchestrations in a project |
| GET    | `/api/v1/orchestrations/:orchestration_id` | Get orchestration details        |
| PATCH  | `/api/v1/orchestrations/:orchestration_id` | Update an orchestration          |
| DELETE | `/api/v1/orchestrations/:orchestration_id` | Delete an orchestration          |

### Orchestration Runs

| Method | Path                                                                | Description                        |
| ------ | ------------------------------------------------------------------- | ---------------------------------- |
| POST   | `/api/v1/orchestrations/:orchestration_id/runs`                     | Start a new run                    |
| GET    | `/api/v1/orchestrations/:orchestration_id/runs`                     | List runs for an orchestration     |
| GET    | `/api/v1/orchestrations/:orchestration_id/runs/:run_id`             | Get run status/state/artifacts     |
| POST   | `/api/v1/orchestrations/:orchestration_id/runs/:run_id/human-input` | Submit human input to a paused run |
| POST   | `/api/v1/orchestrations/:orchestration_id/runs/:run_id/cancel`      | Cancel a running orchestration     |
| POST   | `/api/v1/orchestrations/:orchestration_id/runs/:run_id/resume`      | Resume from checkpoint             |

### Create Orchestration — Request

```json
{
  "project_id": "prj_01",
  "name": "Customer Risk Assessment",
  "description": "Fetches customer data, analyzes risk, routes to approval or auto-approve",
  "input_schema": {
    "type": "object",
    "properties": {
      "customer_id": { "type": "string" }
    },
    "required": ["customer_id"]
  },
  "state_schema": {
    "type": "object",
    "properties": {
      "customer_id": { "type": "string" },
      "customer_data": { "type": "object" },
      "risk_score": { "type": "number" },
      "risk_factors": { "type": "array" },
      "decision": { "type": "string" }
    }
  },
  "nodes": [
    {
      "id": "fetch_customer",
      "type": "tool",
      "tool_type": "http",
      "tool_id": "tool_crm_api",
      "input_mapping": { "customer_id": "state.customer_id" },
      "output_mapping": { "result": "state.customer_data" }
    },
    {
      "id": "search_history",
      "type": "knowledge",
      "input_mapping": {
        "query": "state.customer_id",
        "memory_tags": ["customer-interactions"]
      },
      "output_mapping": { "results": "state.interaction_history" }
    },
    {
      "id": "analyze_risk",
      "type": "agent",
      "agent_id": "agt_risk_analyst",
      "input_mapping": {
        "customer": "state.customer_data",
        "history": "state.interaction_history"
      },
      "output_mapping": {
        "risk_score": "state.risk_score",
        "risk_factors": "state.risk_factors"
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "risk_score": { "type": "number" },
          "risk_factors": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    {
      "id": "check_risk",
      "type": "condition",
      "expression": "state.risk_score > 0.7 ? 'high' : 'low'"
    },
    {
      "id": "human_review",
      "type": "human",
      "prompt": "High-risk customer detected. Review and decide.",
      "input_mapping": {
        "customer": "state.customer_data",
        "risk_score": "state.risk_score",
        "risk_factors": "state.risk_factors"
      },
      "output_mapping": { "decision": "state.decision" },
      "options": ["approve", "reject", "escalate"]
    },
    {
      "id": "auto_approve",
      "type": "transform",
      "expression": "'approved'",
      "output_mapping": { "result": "state.decision" }
    },
    {
      "id": "update_crm",
      "type": "tool",
      "tool_type": "http",
      "tool_id": "tool_crm_api",
      "operation_id": "updateCustomerStatus",
      "input_mapping": {
        "customer_id": "state.customer_id",
        "decision": "state.decision"
      }
    }
  ],
  "edges": [
    { "from": "fetch_customer", "to": "analyze_risk" },
    {
      "from": "search_history",
      "to": "analyze_risk",
      "activation_group": "inputs",
      "activation_condition": "all"
    },
    { "from": "analyze_risk", "to": "check_risk" },
    { "from": "check_risk", "to": "human_review", "condition": "high" },
    { "from": "check_risk", "to": "auto_approve", "condition": "low" },
    { "from": "human_review", "to": "update_crm" },
    { "from": "auto_approve", "to": "update_crm" }
  ]
}
```

### Start Run — Request

```json
{
  "input": {
    "customer_id": "cust_12345"
  }
}
```

### Start Run — Response

```json
{
  "id": "run_abc123",
  "orchestration_id": "orch_risk_assessment",
  "status": "running",
  "state": { "customer_id": "cust_12345" },
  "active_nodes": ["fetch_customer", "search_history"],
  "artifacts": {},
  "trace_id": "trc_xyz",
  "started_at": "2026-05-25T10:00:00Z"
}
```

### Get Run — Response (paused)

```json
{
  "id": "run_abc123",
  "orchestration_id": "orch_risk_assessment",
  "status": "paused",
  "state": {
    "customer_id": "cust_12345",
    "customer_data": { "name": "Acme Corp", "tier": "enterprise" },
    "risk_score": 0.85,
    "risk_factors": ["unusual transaction volume", "new payment method"]
  },
  "active_nodes": ["human_review"],
  "artifacts": {
    "fetch_customer": { "name": "Acme Corp", "tier": "enterprise" },
    "analyze_risk": { "risk_score": 0.85, "risk_factors": ["..."] }
  },
  "required_action": {
    "node_id": "human_review",
    "prompt": "High-risk customer detected. Review and decide.",
    "context": {
      "customer": { "name": "Acme Corp", "tier": "enterprise" },
      "risk_score": 0.85,
      "risk_factors": ["unusual transaction volume", "new payment method"]
    },
    "options": ["approve", "reject", "escalate"]
  },
  "trace_id": "trc_xyz",
  "started_at": "2026-05-25T10:00:00Z"
}
```

### Submit Human Input — Request

```json
{
  "node_id": "human_review",
  "output": {
    "decision": "approve"
  }
}
```

---

## Example Pipelines

### Simple: Document Processing (no LLM except analysis)

```
[tool: fetch-document] → [transform: extract-metadata] → [agent: summarize] → [memory_write: store-summary]
```

4 nodes, 1 LLM call. The other 3 are deterministic and instant.

### Parallel: Multi-Source Research

```
                ┌→ [tool: search-arxiv] ──────┐
[transform: prepare-queries] → [tool: search-web] ───────→ [agent: synthesize] → [tool: create-document]
                └→ [knowledge: search-internal] ─┘
```

Fan-out to 3 data sources in parallel, fan-in to one synthesis agent.

### Conditional: Content Pipeline with Review

```
[agent: write-draft] → [agent: review] → [condition: quality > 0.8?]
                                               ├── yes → [tool: publish]
                                               └── no → [human: editor-review] → [agent: revise] → [tool: publish]
```

### Loop: Batch Customer Analysis

```
[tool: list-customers] → [loop: for each customer → run orch_single_customer_analysis] → [agent: generate-report]
```

Processes N customers in parallel (with configurable concurrency), then generates a summary report.

---

## Observability

Every orchestration run creates a trace tree:

```
trace: run_abc123 (root)
├── trace: node_fetch_customer (tool call)
├── trace: node_search_history (knowledge search)
├── trace: node_analyze_risk (agent generation — has sub-traces for LLM calls)
├── trace: node_check_risk (condition evaluation)
├── trace: node_human_review (paused → resumed)
└── trace: node_update_crm (tool call)
```

Each node execution is a child trace of the run's root trace. Agent nodes produce sub-traces for their LLM calls and tool invocations (existing trace infrastructure).

---

## Permissions

| Permission                           | Endpoint                                                  |
| ------------------------------------ | --------------------------------------------------------- |
| `orchestrations:CreateOrchestration` | `POST /api/v1/orchestrations`                             |
| `orchestrations:ListOrchestrations`  | `GET /api/v1/orchestrations`                              |
| `orchestrations:GetOrchestration`    | `GET /api/v1/orchestrations/:id`                          |
| `orchestrations:UpdateOrchestration` | `PATCH /api/v1/orchestrations/:id`                        |
| `orchestrations:DeleteOrchestration` | `DELETE /api/v1/orchestrations/:id`                       |
| `orchestrations:StartRun`            | `POST /api/v1/orchestrations/:id/runs`                    |
| `orchestrations:ListRuns`            | `GET /api/v1/orchestrations/:id/runs`                     |
| `orchestrations:GetRun`              | `GET /api/v1/orchestrations/:id/runs/:runId`              |
| `orchestrations:SubmitHumanInput`    | `POST /api/v1/orchestrations/:id/runs/:runId/human-input` |
| `orchestrations:CancelRun`           | `POST /api/v1/orchestrations/:id/runs/:runId/cancel`      |
| `orchestrations:ResumeRun`           | `POST /api/v1/orchestrations/:id/runs/:runId/resume`      |

Tool execution within nodes inherits the run creator's permissions. Agent nodes execute as the run creator (same auth propagation as existing multi-agent flows).

---

## Prerequisite: Tools Module (Decoupled from Agents)

Today, tools are a sub-resource of the agents module ("Agent Tools", `agt_tool_` prefix, `/api/v1/agent-tools`). For orchestrations to reference the same tool definitions, tools must become a **standalone first-class module**. Since SOAT has no external consumers yet, the agent-tools module will be **removed entirely** (no deprecation period, no aliases).

### Replacement: Agent Tools → Tools Module

| Aspect    | Removed (Agent Tools)         | Replacement (Tools Module)   |
| --------- | ----------------------------- | ---------------------------- |
| Prefix    | `agt_tool_`                   | `tool_`                      |
| Endpoints | `/api/v1/agent-tools`         | `/api/v1/tools`              |
| Ownership | Sub-resource of agents module | Standalone module            |
| Consumers | Agents only                   | Agents + Orchestration nodes |
| Types     | http, client, mcp, soat       | Same — no new types needed   |

### Why a Separate Module?

1. **Shared resource** — A single HTTP tool definition (e.g., "CRM API") should be usable by agents for LLM-driven calls AND by orchestration `tool` nodes for deterministic calls.
2. **Independent lifecycle** — Tools have their own CRUD, permissions, and formation type. They don't logically belong to agents.
3. **Cleaner semantics** — An orchestration `tool` node doesn't involve an agent at all. Referencing an "Agent Tool" from a non-agent context is confusing.
4. **Single execution infrastructure** — `executeHttpTool()`, MCP client, and `executeSoatTool()` are already generic. They just need to resolve a `Tool` record by ID regardless of who's calling.

### Tools Module Surface

```
POST   /api/v1/tools          — Create a tool
GET    /api/v1/tools          — List tools in a project
GET    /api/v1/tools/:tool_id — Get tool details
PATCH  /api/v1/tools/:tool_id — Update a tool
DELETE /api/v1/tools/:tool_id — Delete a tool
```

The `type` field remains: `http`, `client`, `mcp`, `soat`. All existing fields (`execute`, `mcp`, `actions`, `parameters`, `preset_parameters`) carry over unchanged.

Agents reference tools via `tool_ids` (array of `tool_` IDs). Orchestration `tool` nodes reference a single tool via `tool_id`.

---

## Integration with Existing Modules

### Agents

Agent nodes use the existing `createGeneration()` infrastructure. The orchestration engine:

1. Builds messages from state via `inputMapping`
2. Calls `createGeneration({ agentId, messages, structuredOutput })` with the run's auth context
3. Waits for completion (or handles `requires_action` if agent uses client tools)
4. Extracts structured output as the node artifact

### Tools

Tool nodes resolve a tool from the standalone **Tools module** by `tool_id`:

- HTTP tools: resolved via `Tool` model, executed with `executeHttpTool()`
- MCP tools: resolved and executed via MCP client
- SOAT tools: resolved from OpenAPI specs, executed as internal HTTP calls (same as `executeSoatTool()`)

The execution path is identical to what agents use today — the only difference is that orchestration nodes call tools deterministically (inputs from state mapping) rather than having the LLM decide arguments.

### Knowledge

Knowledge nodes call `searchKnowledge()` directly with parameters mapped from state. No LLM involvement — just a database query.

### Traces

Each run gets a root trace. Each node execution creates a child trace. This integrates with the existing trace module for full observability.

### Formations

Orchestrations can be managed via formations (infrastructure-as-code):

```yaml
type: orchestration
properties:
  name: Customer Risk Assessment
  nodes: [...]
  edges: [...]
```

Tools also get their own formation type:

```yaml
type: tool
properties:
  name: crm-api
  type: http
  execute:
    url: https://api.crm.com/v1/customers/{customer_id}
    method: GET
```

---

## Phased Implementation

### Phase 0 — Tools Module Extraction (Prerequisite)

**Scope:** Remove agent-tools module entirely and replace with a standalone Tools module. This unblocks orchestration `tool` nodes.

**Deliverables:**

- Delete `AgentTool` model, `/api/v1/agent-tools` routes, OpenAPI spec, permissions, tests
- New `Tool` model with `tool_` prefix
- `POST/GET/PATCH/DELETE /api/v1/tools` endpoints
- Agents updated to reference `tool_ids` (array of `tool_` IDs)
- SDK + CLI regenerated
- Permissions: `tools:CreateTool`, `tools:ListTools`, etc.
- Formation type: `tool`
- Update smoke tests and tutorials to use `/api/v1/tools`

### Phase 1 — Linear Pipelines

**Scope:** Sequential node execution, `agent`, `tool`, `transform`, `knowledge`, `memory_write` node types. Basic state management and artifact passing.

**Deliverables:**

- `Orchestration` and `OrchestrationRun` models
- CRUD endpoints for orchestrations
- Run creation and sequential execution engine
- Node executors for: `agent`, `tool`, `transform`, `knowledge`, `memory_write`
- Basic state + artifact tracking
- Trace integration

### Phase 2 — Parallel & Conditional

**Scope:** Parallel fan-out/fan-in, `condition` node type, edge conditions, activation groups.

**Deliverables:**

- Parallel node execution with `Promise.all`
- Edge condition evaluation
- Activation groups (`all`/`any`)
- `condition` node type
- Graph validation (cycle detection for this phase — no cycles yet)

### Phase 3 — Human Gates & Checkpointing

**Scope:** `human` node type, `webhook` node, `delay` node, checkpoint/resume.

**Deliverables:**

- `human` node type + `required_action` pattern
- Human input submission endpoint
- `OrchestrationCheckpoint` model
- Resume from checkpoint
- `webhook` node (receive mode)
- `delay` node with scheduled wake-up
- Run cancellation

### Phase 4 — Cycles & Dynamic Routing

**Scope:** `loop` node, cycles in graphs, LLM-evaluated conditions, sub-orchestrations.

**Deliverables:**

- `loop` node with parallelism control
- Cycle support with termination conditions (max iterations)
- LLM-evaluated edge conditions (agent decides which path)
- Sub-orchestration references (orchestration as a node)
- `webhook` emit mode

---

## Design Decisions

### Why not embed orchestration logic in agents?

Agents are LLM-powered reasoning engines. Using an LLM to decide "call tool A, then tool B, then tool C" when you know the exact sequence is wasteful ($), slow (latency), and unreliable (the LLM might skip steps or change order).

Orchestrations separate **what to do** (deterministic graph) from **how to think** (LLM in agent nodes).

### Why typed state instead of message passing?

Message passing (conversation history) works for chat but fails for structured workflows:

- Messages are untyped text — downstream nodes have to "understand" what upstream sent
- Message history grows linearly — later nodes see irrelevant early context
- No way to express "take field X from step 2 and field Y from step 5"

Typed state gives each node exactly the inputs it needs, in the exact structure it expects.

### Why separate from sessions?

Sessions are conversational (append-only message history, turn-based). Orchestrations are workflow (directed graph, state accumulation, parallel execution). They serve different use cases:

- Session: "Chat with a customer support agent"
- Orchestration: "Process this insurance claim through 7 steps with 3 approval gates"

An agent node in an orchestration may internally use a session for multi-turn reasoning, but the orchestration itself is not a conversation.

### Expression Language

Transform and condition nodes use a safe expression subset. Options:

- **JSONata** — purpose-built for JSON transformation, widely supported
- **Safe JS subset** — more familiar, but needs sandboxing (no `eval`, `Function`, `require`)
- **JSONPath + simple operators** — minimal but limited

Recommendation: Start with a simple expression language in Phase 1 (dot-path access + basic operators) and evaluate JSONata for Phase 2+.
