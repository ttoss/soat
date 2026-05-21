---
sidebar_label: Agent
sidebar_position: 4
---

# Agent

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Creates an AI agent backed by a provider. The agent handles requests, runs tools, and can be attached to actors.

## Syntax

```yaml
type: agent
properties:
  ai_provider_id: String
  name: String
  instructions: String
  model: String
  tool_ids: String[]
  max_steps: Integer
  tool_choice: Object
  stop_conditions: StopConditions[]
  active_tool_ids: String[]
  step_rules: StepRules[]
  boundary_policy: BoundaryPolicy
  temperature: Number
  knowledge_config: KnowledgeConfig
```

_Types: [StopConditions[]](#stopconditions) · [StepRules[]](#steprules) · [BoundaryPolicy](#boundarypolicy) · [KnowledgeConfig](#knowledgeconfig)_

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyAgent
```

## Properties

**`ai_provider_id`**

Public ID of the AI provider

_Required_: Yes
_Type_: String

---

**`name`**

Agent display name

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`instructions`**

System instructions for the agent

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`model`**

Model identifier (overrides provider default)

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`tool_ids`**

Agent tool IDs to attach

_Required_: No
_Type_: Array of String
_Nullable_: Yes

---

**`max_steps`**

Maximum number of agentic steps per generation

_Required_: No
_Type_: Integer
_Nullable_: Yes

---

**`tool_choice`**

Controls how the model selects tools. Examples: `&#123; "type": "auto" &#125;`, `&#123; "type": "none" &#125;`, `&#123; "type": "required" &#125;`, or `&#123; "type": "tool", "name": "my_tool" &#125;`.

_Required_: No
_Type_: Object
_Nullable_: Yes

---

**`stop_conditions`**

Conditions that stop multi-step generation early. The loop stops when any condition is met.

_Required_: No
_Type_: Array of [StopConditions](#stopconditions)
_Nullable_: Yes

---

**`active_tool_ids`**

Subset of tool_ids that are active

_Required_: No
_Type_: Array of String
_Nullable_: Yes

---

**`step_rules`**

Per-step overrides applied during multi-step generation. Steps not covered by a rule use the agent defaults.

_Required_: No
_Type_: Array of [StepRules](#steprules)
_Nullable_: Yes

---

**`boundary_policy`**

Restricts which SOAT actions the agent may invoke. Evaluated as the intersection with the caller's own policy.

_Required_: No
_Type_: [BoundaryPolicy](#boundarypolicy)
_Nullable_: Yes

---

**`temperature`**

Sampling temperature

_Required_: No
_Type_: Number
_Nullable_: Yes

---

**`knowledge_config`**

Knowledge retrieval configuration. When set, relevant documents and memory entries are injected into every generation.

_Required_: No
_Type_: [KnowledgeConfig](#knowledgeconfig)
_Nullable_: Yes

---

## Sub-types

### StopConditions

Properties of each item in `stop_conditions`.

**`type`**

Condition type — currently `hasToolCall`

_Required_: No
_Type_: String

---

**`tool_name`**

Tool name to match when type is `hasToolCall`

_Required_: No
_Type_: String
_Nullable_: Yes

---

### StepRules

Properties of each item in `step_rules`.

**`step`**

1-indexed step number this rule applies to

_Required_: No
_Type_: Integer

---

**`tool_choice`**

Tool choice override for this step, e.g. `auto`, `required`, or `&#123; type: tool, tool_name: search &#125;`

_Required_: No
_Type_: Object
_Nullable_: Yes

---

**`active_tool_ids`**

Tool IDs active on this step

_Required_: No
_Type_: Array of String
_Nullable_: Yes

---

### BoundaryPolicy

Properties of the `boundary_policy` object.

**`statement`**

List of IAM policy statements

_Required_: No
_Type_: Array of [Statement](#statement)

---

### Statement

Properties of each item in `statement`.

**`effect`**

Effect — `Allow` or `Deny`

_Required_: No
_Type_: String

---

**`action`**

IAM action strings, e.g. `memories:*` or `agents:DeleteAgent`

_Required_: No
_Type_: Array of String

---

**`resource`**

Resource SRN patterns (optional; omit to match all resources)

_Required_: No
_Type_: Array of String
_Nullable_: Yes

---

### KnowledgeConfig

Properties of the `knowledge_config` object.

**`memory_ids`**

Public IDs of memories to retrieve from

_Required_: No
_Type_: Array of String

---

**`memory_tags`**

Retrieve from all memories matching these tags

_Required_: No
_Type_: Array of String

---

**`document_ids`**

Public IDs of documents to retrieve from

_Required_: No
_Type_: Array of String

---

**`document_paths`**

Retrieve from all documents matching these path prefixes

_Required_: No
_Type_: Array of String

---

**`min_score`**

Minimum similarity score (0–1) for retrieved chunks

_Required_: No
_Type_: Number

---

**`limit`**

Maximum number of chunks to inject

_Required_: No
_Type_: Integer

---

**`write_memory_id`**

Public ID of the memory the agent can write to. When set, a `write_memory` tool is automatically available to the agent.

_Required_: No
_Type_: String
_Nullable_: Yes

---
