# SOAT — Infrastructure for production-ready AI agents

<p align="center">
  <img src="./packages/website/static/img/soat-architecture.png" alt="SOAT Architecture" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![SafeSkill 92/100](https://img.shields.io/badge/SafeSkill-92%2F100_Verified%20Safe-brightgreen)](https://safeskill.dev/scan/ttoss-soat)
[![Docker Image Version](https://img.shields.io/docker/v/ttoss/soat?label=docker)](https://hub.docker.com/r/ttoss/soat)
[![Docker Pulls](https://img.shields.io/docker/pulls/ttoss/soat)](https://hub.docker.com/r/ttoss/soat)

**SOAT** is open-source infrastructure for building AI applications. One self-hostable Node.js server gives you IAM, file and document storage with vector search, multimodal ingestion, conversational memory, agent orchestration, DAG-based multi-agent workflows, retrieval-augmented generation, guardrails and human approvals, usage metering and quotas, versioned agents with canary rollout, declarative stack deployment, a built-in web console, and a full Model Context Protocol server with first-party OAuth — backed by PostgreSQL.

You bring the product. SOAT handles the infrastructure layer.

## Why SOAT?

Shipping AI applications means rebuilding the same infrastructure on every project: users, API keys, encrypted secrets, file storage, embeddings, conversation history, agent tool calling, traces, observability. SOAT solves all of it once and exposes it through five equivalent surfaces — REST, MCP, CLI, TypeScript SDK, and a built-in web app — so the same operation runs the same way whether you call it from a backend, Claude Desktop, a CI script, the bundled UI, or your own frontend.

SOAT organizes that surface around the [four layers of an agent system](https://soat.ttoss.dev/docs/getting-started/agent-system-layers): the **harness** (what an agent can reach and what it is forbidden), the **loop** (what proves a run did the job), the **graph** (what is allowed to happen next), and the **ratchet** (what proves a change to the agent was an improvement). The first three are shipped in depth; the ratchet is where the platform is heading — see [What SOAT is becoming](#what-soat-is-becoming).

## Highlights

- **Identity & access** — users, projects, JWTs, project keys, personal API keys, and reusable [IAM policy documents](https://soat.ttoss.dev/docs/modules/iam) enforced consistently on every surface.
- **Files, documents, memories & knowledge** — pgvector-backed semantic search across documents and memory entries, with memory containers that keep durable context for agents. See [Files](https://soat.ttoss.dev/docs/modules/files), [Documents](https://soat.ttoss.dev/docs/modules/documents), [Memories](https://soat.ttoss.dev/docs/modules/memories), and [Knowledge](https://soat.ttoss.dev/docs/modules/knowledge).
- **Multimodal ingestion** — [Ingestion Rules](https://soat.ttoss.dev/docs/modules/ingestion-rules) route images, audio, and scanned PDFs through converter tools or multimodal agents (OCR, speech-to-text, vision) into the same document search pipeline.
- **Agents that actually do things** — tool-calling reasoning loops with HTTP, MCP, client-side, and SOAT-platform tools, including multi-agent workflows where agents invoke other agents. See [Agents](https://soat.ttoss.dev/docs/modules/agents).
- **Deterministic orchestrations** — [Orchestrations](https://soat.ttoss.dev/docs/modules/orchestrations) chain agents, tools, and knowledge lookups into DAG-based workflows with parallel execution rounds, conditional branching, delays, polling, and loops.
- **Declarative deployments** — [Formations](https://soat.ttoss.dev/docs/modules/formations) let you define providers, memories, tools, agents, and orchestrations in a single template and deploy in dependency order.
- **Sessions** — a 1-user ↔ 1-agent interface that hides actors and conversations. Two API calls take a user from message to answer. See [Sessions](https://soat.ttoss.dev/docs/modules/sessions).
- **Direct LLM completions** — an OpenAI-compatible chat completions endpoint with SSE streaming, stateless or with stored per-chat configuration, for when you don't need an agent at all. See [Chats](https://soat.ttoss.dev/docs/modules/chats).
- **Async generations** — kick off long-running agent runs, poll for status, or fire a webhook on completion.
- **Operations** — encrypted secrets, HMAC-signed webhooks with event-pattern subscriptions, and trace records for every generation. See [Webhooks](https://soat.ttoss.dev/docs/modules/webhooks) and [Traces](https://soat.ttoss.dev/docs/modules/traces).
- **Guardrails & approvals** — [Guardrails](https://soat.ttoss.dev/docs/modules/guardrails) classify every agent tool call from its actual arguments, deterministically, before anything touches the outside world; risky actions land in a human [Approvals](https://soat.ttoss.dev/docs/modules/approvals) queue with frozen evidence and hard expiry.
- **Budgets & metering** — [Quotas](https://soat.ttoss.dev/docs/modules/quotas) fail closed on request, token, or cost caps; [Usage](https://soat.ttoss.dev/docs/modules/usage) meters every LLM call, node execution, and stored byte with alert thresholds.
- **Versioned agents with canary rollout** — every config change is archived as an append-only [agent version](https://soat.ttoss.dev/docs/modules/agents), a deterministic stable/canary split stages rollouts, and every generation records the version that served it.
- **MCP native** — every operation is automatically available as an MCP tool, and SOAT acts as a first-party OAuth 2.1 authorization server so MCP clients like Claude Desktop, Cursor, and VS Code connect with the standard authorize + PKCE flow. See [MCP docs](https://soat.ttoss.dev/docs/mcp) and [OAuth](https://soat.ttoss.dev/docs/modules/oauth).

## What SOAT is becoming

An agent platform that only records what agents _did_ cannot tell you whether the next change makes them _better_. SOAT's direction is the **ratchet** — the layer that governs change itself: produce a verdict from evidence, gate the change on the verdict, keep history append-only so nothing slides backward silently. The framing lives in [The Layers of an Agent System](https://soat.ttoss.dev/docs/getting-started/agent-system-layers).

Shipped today (see [`docs/roadmap.md`](./docs/roadmap.md) for what comes next): append-only agent versions with staged canary rollout, served-version stamping on every generation, the approvals recurrence view that surfaces repeated human corrections, and —

- **[Evaluations](https://soat.ttoss.dev/docs/modules/evaluations)** — datasets, deterministic and LLM-judge scorers, and scored runs of the real agent, comparable against a baseline: "did this change make the agent worse?" as a pass/fail verdict.
- **[Eval-gated promotion](https://soat.ttoss.dev/docs/modules/agents#eval-gated-promotion)** — a canary that promotes on a passing eval run against that canary instead of a hunch.

The stance behind all of it: the platform owns the queue, the recurrence signal, and the verdict; a human owns the judgment. Promotion is never automatic.

## Documentation

**[Read the full documentation](https://soat.ttoss.dev/docs/introduction)** — quick start, key concepts, module reference, API, MCP, CLI, and SDK guides.

## Getting Started

The fastest path is Docker Compose:

```bash
git clone https://github.com/ttoss/soat.git
cd soat
```

Follow the **[Getting Started Guide](https://soat.ttoss.dev/docs/getting-started)** to bring up the server and database in under five minutes.

## Client surfaces

| Surface               | Best for                                                | Docs                            |
| --------------------- | ------------------------------------------------------- | ------------------------------- |
| **REST API**          | Backend services and custom integrations                | https://soat.ttoss.dev/docs/api |
| **MCP server**        | Claude Desktop, Cursor, and other MCP-aware AI runtimes | https://soat.ttoss.dev/docs/mcp |
| **CLI** (`soat`)      | Scripts, CI pipelines, and local exploration            | https://soat.ttoss.dev/docs/cli |
| **SDK** (`@soat/sdk`) | TypeScript and JavaScript applications                  | https://soat.ttoss.dev/docs/sdk |
| **Web app**           | Browsing and managing resources from the browser        | Served by the server at `/app`  |

All five hit the same business logic and the same permission engine.

## Repository layout

This is a monorepo managed with pnpm and Turbo:

- `packages/server` — the SOAT server (REST + MCP, business logic, permissions)
- `packages/postgresdb` — Sequelize models and database utilities
- `packages/sdk` — TypeScript SDK generated from the OpenAPI specs
- `packages/cli` — the `soat` command-line client
- `packages/app` — the web UI (React), served by the server at `/app`
- `packages/website` — the documentation site (Docusaurus)

## Contributing

Issues and pull requests are welcome. Run the tests with `pnpm --filter @soat/server test` and the smoke suite with `pnpm run -w smoke-tests`.

## License

MIT — see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [ttoss](https://ttoss.dev) — for `@ttoss/http-server` and `@ttoss/http-server-mcp`
- [pgvector](https://github.com/pgvector/pgvector) — PostgreSQL vector similarity search
- [Ollama](https://ollama.com) — local LLM and embedding models
