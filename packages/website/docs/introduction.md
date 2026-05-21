---
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Introduction

**SOAT is the infrastructure layer for production-ready AI agents.** It bundles IAM, file and document storage, vector search, conversational memory, agent orchestration, multi-agent workflows, retrieval-augmented generation, declarative stack deployment, and a full MCP server into a single self-hostable Node.js service backed by PostgreSQL.

If you have ever shipped an AI product, you know the pattern: half the codebase is plumbing — users, API keys, embeddings, conversation history, tool calling, traces. SOAT solves all of it once, exposes it through four equivalent client surfaces, and gets out of your way.

## What you get out of the box

### Identity & access management

- Users, projects, and project memberships
- Per-resource permissions via reusable [IAM policy documents](/docs/modules/iam)
- User JWTs, project API keys, and personal API keys with policy attachments

### Storage & retrieval

- [Files](/docs/modules/files) and structured [documents](/docs/modules/documents) scoped to projects
- pgvector embeddings and semantic search with score thresholds
- [Memories](/docs/modules/memories) as durable context stores, plus [Knowledge](/docs/modules/knowledge) for unified search across documents and memory entries

### Agents & conversations

- Configurable [agents](/docs/modules/agents) with HTTP, MCP, client-side, and `soat`-platform tools
- Multi-step reasoning loops with `tool_choice`, step rules, and boundary policies
- **Multi-agent workflows**: agents call other agents as tools
- **Async generations**: long-running jobs you can poll or wait on
- [Sessions](/docs/modules/sessions) — a 1↔1 user/agent interface that hides actors and conversations
- [Conversations](/docs/modules/conversations) — multi-party message engine when you need full control
- [Chats](/docs/modules/chats) — raw LLM completions when you don't need an agent at all

### Operations

- Encrypted [secrets](/docs/modules/secrets) for provider keys
- HMAC-signed [webhooks](/docs/modules/webhooks) with event-pattern subscriptions
- Trace records for every generation — tool calls, latency, and cost-relevant fields

### Declarative deployment

- [Agent formations](/docs/modules/formations) to define full agent stacks (providers, memories, tools, agents) in JSON/YAML
- Dependency-aware provisioning with operation history and event logs for each deployment

## Architecture

SOAT runs as a single Node.js server backed by PostgreSQL with [pgvector](https://github.com/pgvector/pgvector). One process exposes both the REST API and the Streamable HTTP MCP endpoint — both call the same business-logic layer and the same permission engine.

<div style={{display: 'flex', justifyContent: 'center'}}>
  <img src="/img/architecture.svg" alt="SOAT Architecture" style={{width: '100%', maxWidth: 720}} />
</div>

## One backend, four surfaces

Every operation in SOAT is reachable through four interchangeable client surfaces. They share the same permission check, the same business logic, and the same response shape — pick the one that fits the job.

| Surface               | Best for                                             | Docs                       |
| --------------------- | ---------------------------------------------------- | -------------------------- |
| **REST API**          | Backend services, custom integrations                | [API Reference](/docs/api) |
| **MCP server**        | Claude Desktop, Cursor, and other MCP-aware runtimes | [MCP](/docs/mcp)           |
| **CLI** (`soat`)      | Scripts, CI pipelines, and local exploration         | [CLI](/docs/cli)           |
| **SDK** (`@soat/sdk`) | TypeScript and JavaScript applications               | [SDK](/docs/sdk)           |

Each operation is gated by a single [permission action](/docs/permissions) (e.g. `documents:CreateDocument`) that is enforced consistently across all four surfaces. See [IAM & Policies](/docs/modules/iam) for how policies are evaluated.

## Example — create a document

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

## Where to next

- **[Get started](/docs/getting-started)** — bring up SOAT with Docker Compose in five minutes
- **[Key concepts](/docs/getting-started/concepts)** — the mental model behind projects, agents, and sessions
- **[Modules](/docs/modules/iam)** — deep-dives into every resource type
