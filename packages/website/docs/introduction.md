---
description: 'SOAT is a self-hostable infrastructure layer for production-ready AI agents: IAM, storage, vector search, memory, orchestration, RAG, and a full MCP server.'
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Introduction

**SOAT is the infrastructure layer for production-ready AI agents**: IAM, file and document storage, vector search, conversational memory, agent orchestration, multi-agent workflows, RAG, declarative stack deployment, and a full MCP server in one self-hostable Node.js service backed by PostgreSQL.

The platform is organized around the [four layers of an agent system](/docs/agent-system-layers): **harness** (what an agent can reach), **loop** (what proves a run did the job), **graph** (what happens next), **ratchet** (what proves a change was an improvement). The ratchet is the active build front: [Where SOAT is going](#where-soat-is-going).

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

- Configurable [agents](/docs/modules/agents) with HTTP, MCP, client-side, and `builtin`-platform tools
- Multi-step reasoning loops with `tool_choice`, step rules, and boundary policies
- **Multi-agent workflows**: agents call other agents as tools
- **Async generations**: long-running jobs you can poll or wait on
- [Sessions](/docs/modules/sessions) — 1↔1 user/agent interface that hides actors and conversations
- [Conversations](/docs/modules/conversations) — multi-party message engine
- [Chats](/docs/modules/chats) — raw LLM completions without an agent

### Orchestration & automation

- [Orchestrations](/docs/modules/orchestrations) — deterministic DAG pipelines with parallel rounds, conditions, retries, and durable resumption
- [Workflows](/docs/modules/workflows) — state graphs that durable tasks live in and move through, including backward
- [Triggers](/docs/modules/triggers) start a flow on a cron schedule, an inbound webhook, or on demand

### Governance & safety

- [Guardrails](/docs/modules/guardrails) classify every tool call from its arguments, deterministically, before execution
- [Approvals](/docs/modules/approvals) — a human-decision queue with frozen evidence, hard expiry, and a recurrence view over repeated corrections
- [Quotas](/docs/modules/quotas) fail closed on request, token, or cost caps; [Usage](/docs/modules/usage) meters every call with alert thresholds
- Append-only [agent versions](/docs/modules/agents#versioning-and-staged-rollout) with staged canary rollout and served-version stamping

### Operations

- Encrypted [secrets](/docs/modules/secrets) for provider keys
- HMAC-signed [webhooks](/docs/modules/webhooks) with event-pattern subscriptions
- [Traces](/docs/modules/traces) for every generation — tool calls, latency, and cost-relevant fields — plus [exceptions](/docs/modules/exceptions), [activity](/docs/modules/activity), and an [audit log](/docs/modules/audit-log)

### Declarative deployment

- [Agent formations](/docs/modules/formations) to define full agent stacks (providers, memories, tools, agents) in JSON/YAML
- Dependency-aware provisioning with operation history and event logs for each deployment

## Where SOAT is going

The **ratchet**: produce a verdict from evidence, gate every change on it, keep history append-only. Versioned agents, canary rollout, the approvals recurrence view, and:

- **[Evaluations](/docs/modules/evaluations)** — datasets, scorers, and scored runs of the real agent compared against a baseline; a pass/fail verdict
- **[Eval-gated promotion](/docs/modules/agents#eval-gated-promotion)** — a canary release promotes only on a passing eval run against that canary

Promotion stays human-gated. Framing: [The Layers of an Agent System](/docs/agent-system-layers); sequencing: [roadmap](https://github.com/ttoss/soat/blob/main/docs/roadmap.md).

## Architecture

One Node.js process backed by PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) exposes the REST API and the Streamable HTTP MCP endpoint; both call the same business-logic layer and permission engine.

<div style={{display: 'flex', justifyContent: 'center'}}>
  <img src="/img/architecture.svg" alt="SOAT Architecture" style={{width: '100%', maxWidth: 720}} />
</div>

## One backend, four surfaces

| Surface               | Best for                                             | Docs                       |
| --------------------- | ---------------------------------------------------- | -------------------------- |
| **REST API**          | Backend services, custom integrations                | [API Reference](/docs/api) |
| **MCP server**        | Claude Desktop, Cursor, and other MCP-aware runtimes | [MCP](/docs/mcp)           |
| **CLI** (`soat`)      | Scripts, CI pipelines, and local exploration         | [CLI](/docs/cli)           |
| **SDK** (`@soat/sdk`) | TypeScript and JavaScript applications               | [SDK](/docs/sdk)           |

All four share one permission check, one business-logic layer, and one response shape: each operation is gated by one [permission action](/docs/permissions) (e.g. `documents:CreateDocument`) on every surface ([IAM & Policies](/docs/modules/iam)). Trade-offs: [Choosing a Client Surface](/docs/client-surfaces).

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

- **[Get started](/docs/getting-started)** — Docker Compose in five minutes
- **[Key concepts](/docs/getting-started/concepts)** — projects, agents, sessions
- **[Choosing a client surface](/docs/client-surfaces)** — REST, SDK, CLI, or MCP
- **[Platform modules](/docs/modules)** — every resource type
