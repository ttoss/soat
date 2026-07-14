---
description: "Compare SOAT's four client surfaces — REST API, CLI, TypeScript SDK, and MCP — and pick the one that fits where your code runs."
sidebar_position: 3
title: Choosing a Client Surface
---

# Choosing a Client Surface

Every SOAT operation is exposed through four interchangeable client surfaces. They call the same business logic, enforce the same [permission actions](/docs/permissions), and return the same response shapes — the only difference is ergonomics. Pick the surface that fits where your code runs.

| Surface               | Best for                                             | Setup guide                          |
| --------------------- | ---------------------------------------------------- | ------------------------------------ |
| **REST API**          | Backend services in any language, custom integrations | [API Reference](/docs/api)           |
| **SDK** (`@soat/sdk`) | TypeScript and JavaScript applications               | [SDK Introduction](/docs/sdk)        |
| **CLI** (`soat`)      | Scripts, CI pipelines, local exploration             | [CLI Introduction](/docs/cli)        |
| **MCP server**        | Claude Desktop, Cursor, and other MCP-aware runtimes | [Connecting an MCP Client](/docs/mcp/connecting) |

## Rules of thumb

- **Building a product on SOAT?** Use the [SDK](/docs/sdk) if you are in TypeScript — every endpoint, parameter, and response body is fully typed and generated from the OpenAPI specs. In any other language, call the [REST API](/docs/api) directly.
- **Automating or exploring?** Use the [CLI](/docs/cli). Every API operation is a sub-command (`soat create-agent`, `soat list-documents`), so anything you can do in code you can do in a shell script or CI job.
- **Working from an AI assistant?** Connect the [MCP server](/docs/mcp). Any MCP-compatible client can manage projects, agents, documents, and the rest directly from a chat or coding session.

## What is identical across surfaces

- **Authentication** — a user JWT or an `sk_`-prefixed API key works on all four surfaces. See [IAM & Policies](/docs/modules/iam).
- **Permissions** — each operation is gated by a single `resource:Action` permission string (e.g. `documents:CreateDocument`), enforced consistently everywhere. See the [Permissions Reference](/docs/permissions).
- **Data** — a resource created on one surface is immediately visible on the others; they share one backend and one database.

## Field naming

The REST API and SDK use `snake_case` for body fields and path parameters (`project_id`, `{agent_id}`). MCP tool schemas use `camelCase` (`projectId`). The CLI uses kebab-case flags (`--project-id`).
