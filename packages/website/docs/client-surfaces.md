---
description: "Compare SOAT's four client surfaces — REST API, CLI, TypeScript SDK, and MCP — and pick the one that fits where your code runs."
title: Choosing a Client Surface
---

# Choosing a Client Surface

Four interchangeable client surfaces call the same business logic, enforce the same [permission actions](/docs/permissions), and return the same response shapes.

| Surface               | Best for                                             | Setup guide                          |
| --------------------- | ---------------------------------------------------- | ------------------------------------ |
| **REST API**          | Backend services in any language, custom integrations | [API Reference](/docs/api)           |
| **SDK** (`@soat/sdk`) | TypeScript and JavaScript applications               | [SDK Introduction](/docs/sdk)        |
| **CLI** (`soat`)      | Scripts, CI pipelines, local exploration             | [CLI Introduction](/docs/cli)        |
| **MCP server**        | Claude Desktop, Cursor, and other MCP-aware runtimes | [Connecting an MCP Client](/docs/mcp/connecting) |

## Rules of thumb

- **Building a product** — [SDK](/docs/sdk) in TypeScript (typed from the OpenAPI specs); [REST API](/docs/api) in any other language.
- **Automating or exploring** — [CLI](/docs/cli); every API operation is a sub-command (`soat create-agent`, `soat list-documents`).
- **Working from an AI assistant** — [MCP server](/docs/mcp) from any MCP-compatible client.

## What is identical across surfaces

- **Authentication** — a user JWT or an `sk_`-prefixed API key ([IAM & Policies](/docs/modules/iam)).
- **Permissions** — one `resource:Action` string per operation (e.g. `documents:CreateDocument`) ([Permissions Reference](/docs/permissions)).
- **Data** — one backend, one database; a resource created on one surface is visible on the others.

## Field naming

REST API and SDK: `snake_case` body fields and path parameters (`project_id`, `{agent_id}`). MCP tool schemas: the same `snake_case` names (`project_id`); only tool names are kebab-case. CLI: kebab-case flags (`--project-id`).
