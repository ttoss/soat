---
sidebar_label: Agent Tool
sidebar_position: 3
---

# Agent Tool

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Defines a tool (HTTP endpoint, MCP server, or SOAT action) that agents can invoke during a generation.

## Syntax

```yaml
type: agent_tool
properties:
  name: String
  type: String
  description: String
  parameters: Object
  execute: Execute
  mcp: Mcp
  actions: String[]
  preset_parameters: Object
```

_Types: [Execute](#execute) · [Mcp](#mcp)_

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyAgentTool
```

## Properties

**`name`**

Tool display name

_Required_: Yes
_Type_: String

---

**`type`**

Tool type hint (e.g. http, mcp, soat)

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`description`**

Tool description shown to the model

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`parameters`**

JSON Schema describing the tool's input parameters (free-form, user-defined)

_Required_: No
_Type_: Object
_Nullable_: Yes

---

**`execute`**

HTTP execution configuration. Required for `http` tools.

_Required_: No
_Type_: [Execute](#execute)
_Nullable_: Yes

---

**`mcp`**

MCP server connection configuration. Required for `mcp` tools.

_Required_: No
_Type_: [Mcp](#mcp)
_Nullable_: Yes

---

**`actions`**

IAM action strings the tool is permitted to call

_Required_: No
_Type_: Array of String
_Nullable_: Yes

---

**`preset_parameters`**

Pre-filled parameter values injected at execution time

_Required_: No
_Type_: Object
_Nullable_: Yes

---

## Sub-types

### Execute

Properties of the `execute` object.

**`url`**

Endpoint URL. Supports `&#123;param&#125;` placeholders resolved from tool arguments.

_Required_: No
_Type_: String

---

**`method`**

HTTP method (default: `POST`)

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`headers`**

Static headers included in every request

_Required_: No
_Type_: Object
_Nullable_: Yes

---

### Mcp

Properties of the `mcp` object.

**`url`**

MCP server URL

_Required_: No
_Type_: String

---

**`headers`**

Headers included in every MCP request

_Required_: No
_Type_: Object
_Nullable_: Yes

---
