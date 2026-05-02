---
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# introduction

SOAT is open-source infrastructure for building AI applications. It provides the essential backend services — identity and access management, document and file storage with vector search, conversational memory, agent orchestration, and a full MCP server — so you can focus on your product instead of reinventing the plumbing.

## Why SOAT?

Building AI applications requires a surprising amount of backend infrastructure: user management, API keys, persistent storage, semantic search, conversation history, agent execution, and tool integration. Instead of stitching together dozens of services, SOAT gives you everything in a single, self-hostable server.

## Core Capabilities

### Complete Backend

IAM, documents, files, secrets, webhooks, and vector search — all behind a single REST API. SOAT handles authentication, authorization, and data persistence so your application code stays focused on user-facing features.

### Agent Orchestration

Define agents with tools, configure LLM providers, and run multi-turn AI completions. SOAT manages the full agent lifecycle — including tool calling, conversation state, and streaming responses — through a unified API.

### MCP Native

First-class support for the [Model Context Protocol](https://modelcontextprotocol.io/). Every resource managed by SOAT is automatically available as an MCP tool, enabling seamless integration with Claude Desktop, Cursor, and other MCP-compatible runtimes.

## Architecture Overview

SOAT runs as a single Node.js server backed by PostgreSQL (with [pgvector](https://github.com/pgvector/pgvector) for embeddings). The server exposes a REST API and a Streamable HTTP MCP endpoint — both backed by the same business logic and permission engine.

```
┌─────────────────────────────────────────────────────────┐
│                        Clients                          │
│          REST API · MCP · CLI (soat) · SDK              │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│                    SOAT Server                          │
│                                                         │
│  ┌──────────────┐   ┌──────────────────────────────┐   │
│  │  REST Router │   │         MCP Server           │   │
│  └──────┬───────┘   └──────────────┬───────────────┘   │
│         └──────────────┬───────────┘                   │
│                        │                               │
│          ┌─────────────▼────────────┐                  │
│          │       Business Logic     │                  │
│          │  (lib/ · permissions)    │                  │
│          └─────────────┬────────────┘                  │
└────────────────────────┼────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    PostgreSQL                           │
│              (pgvector for embeddings)                  │
└─────────────────────────────────────────────────────────┘
```

The full module reference is in the [Modules](/docs/modules/iam) section of the sidebar.

## Getting Started

Head to the [Getting Started](/docs/getting-started) guide to spin up SOAT with Docker Compose in a few minutes.

## Client Surfaces

Every operation in SOAT is reachable through four surfaces. They are all equivalent — the same permission is checked, the same business logic runs, and the same data is returned regardless of which surface you use.

| Surface               | Best for                                                       | Docs                       |
| --------------------- | -------------------------------------------------------------- | -------------------------- |
| **REST API**          | Backend services, custom integrations                          | [API Reference](/docs/api) |
| **MCP server**        | AI agents and MCP-compatible runtimes (Claude Desktop, Cursor) | [MCP](/docs/mcp)           |
| **CLI** (`soat`)      | Scripts, CI pipelines, local development                       | [CLI](/docs/cli)           |
| **SDK** (`@soat/sdk`) | TypeScript/JavaScript applications                             | [SDK](/docs/sdk)           |

Each operation has a single [permission action](/docs/permissions) (e.g. `documents:CreateDocument`) that controls access across all four surfaces. See [IAM & Policies](/docs/modules/iam) for how policies are evaluated.

### Example — create a document

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-document \
  --project-id proj_ABC \
  --title "Release Notes" \
  --content "Initial release."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.documents.createDocument({
  body: {
    project_id: 'proj_ABC',
    title: 'Release Notes',
    content: 'Initial release.',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/documents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_ABC","title":"Release Notes","content":"Initial release."}'
```

</TabItem>
</Tabs>
