---
sidebar_label: Resource Types
sidebar_position: 1
---

# Formation Resource Types

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Each resource type that can be declared in a Formation template is listed below.
Click a type to see its full properties reference.

## Output

All resource types return the **public ID** of the created resource as their output.
You can reference this ID in other resource properties with a `ref` expression:

```yaml
resources:
  MyMemory:
    type: memory
    properties:
      name: My Memory

  MyEntry:
    type: memory_entry
    properties:
      memory_id:
        ref: MyMemory   # resolves to the public ID of MyMemory
      content: Hello, world
```

## Types

| Type | Description |
| ---- | ----------- |
| [`ai_provider`](./ai-provider) | Configures an LLM provider connection (API key, model, endpoint) that agents use to generate responses. |
| [`agent_tool`](./agent-tool) | Defines a tool (HTTP endpoint, MCP server, or SOAT action) that agents can invoke during a generation. |
| [`agent`](./agent) | Creates an AI agent backed by a provider. The agent handles requests, runs tools, and can be attached to actors. |
| [`actor`](./actor) | Creates a stateful conversation actor that wraps an agent or chat session and optionally links to a memory store. |
| [`document`](./document) | Stores a text document in a project, optionally indexing it for knowledge retrieval. |
| [`memory`](./memory) | Creates a named memory store that actors can read from and write to across conversations. |
| [`memory_entry`](./memory-entry) | Adds a single text entry to a memory store. |
| [`webhook`](./webhook) | Registers an HTTPS endpoint to receive SOAT platform event notifications. |
