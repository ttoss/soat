---
description: 'SOAT is a self-hostable infrastructure layer for production-ready AI agents: IAM, storage, vector search, memory, orchestration, RAG, and a full MCP server.'
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Introduction

**SOAT is the infrastructure layer for production-ready AI agents.** It bundles IAM, file and document storage, vector search, conversational memory, agent orchestration, multi-agent workflows, retrieval-augmented generation, declarative stack deployment, and a full MCP server into a single self-hostable Node.js service backed by PostgreSQL.

If you have ever shipped an AI product, you know the pattern: half the codebase is plumbing — users, API keys, embeddings, conversation history, tool calling, traces. SOAT solves all of it once, exposes it through four equivalent client surfaces, and gets out of your way.

The platform is organized around the [four layers of an agent system](/docs/getting-started/harness-loop-graph-ratchet): the **harness** (what an agent can reach), the **loop** (what proves a run did the job), the **graph** (what happens next), and the **ratchet** (what proves a change was an improvement). The first three are shipped in depth; the ratchet is the active build front — see [Where SOAT is going](#where-soat-is-going).

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

### Orchestration & automation

- [Orchestrations](/docs/modules/orchestrations) — deterministic DAG pipelines with parallel rounds, conditions, retries, and durable resumption
- [Workflows](/docs/modules/workflows) — state graphs that durable tasks live in and move through, including backward
- [Triggers](/docs/modules/triggers) start a flow on a cron schedule, an inbound webhook, or on demand
- [Discussions](/docs/modules/discussions) — structured multi-agent panel reasoning

### Governance & safety

- [Guardrails](/docs/modules/guardrails) classify every tool call from its actual arguments — deterministically, before anything executes
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

Everything above records what agents _did_ or constrains what they _may do_. The direction of the platform is the layer that governs what they _become_: the **ratchet** — produce a verdict from evidence, gate every change on the verdict, keep history append-only so nothing regresses silently.

The shipped foundation is already in place: versioned agents, canary rollout, and the approvals recurrence view. Building on it, designed and coming next:

- **[Evaluations](/docs/modules/evaluations)** — datasets, scorers, and scored runs of the real agent, comparable against a baseline, answering "did this change make the agent worse?" with a pass/fail verdict
- **Eval-gated promotion** — a canary release that promotes on a passing eval run rather than a judgment call
- **[Learned Rules](/docs/modules/learned-rules)** — human corrections captured, clustered when they recur, and promoted by a human into versioned scoped rules, with a graduation path to hard guardrail enforcement

Promotion stays human-gated by design: the platform owns the queue, the recurrence signal, and the verdict — a human owns the judgment. The full framing is in [Harness, Loop, Graph, and Ratchet](/docs/getting-started/harness-loop-graph-ratchet), and sequencing lives in the [roadmap](https://github.com/ttoss/soat/blob/main/docs/roadmap.md).

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
- **[Platform modules](/docs/modules)** — deep-dives into every resource type
