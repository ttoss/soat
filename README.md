# SOAT — The complete backend for AI apps

<p align="center">
  <img src="./packages/website/static/img/soat-architecture.png" alt="SOAT Architecture" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![SafeSkill 92/100](https://img.shields.io/badge/SafeSkill-92%2F100_Verified%20Safe-brightgreen)](https://safeskill.dev/scan/ttoss-soat)

**SOAT** is open-source infrastructure for building AI applications. One self-hostable Node.js server gives you IAM, file and document storage with vector search, conversational memory, agent orchestration, multi-agent workflows, retrieval-augmented generation, and a full Model Context Protocol server — backed by PostgreSQL.

You bring the product. SOAT handles the plumbing.

## Why SOAT?

Shipping AI applications means rebuilding the same infrastructure on every project: users, API keys, encrypted secrets, file storage, embeddings, conversation history, agent tool calling, traces, observability. SOAT solves all of it once and exposes it through four equivalent surfaces — REST, MCP, CLI, and TypeScript SDK — so the same operation runs the same way whether you call it from a backend, Claude Desktop, a CI script, or your own UI.

## Highlights

- **Identity & access** — users, projects, project memberships, JWTs, project keys, personal API keys, and reusable IAM policy documents enforced consistently on every surface.
- **Files, documents & RAG** — pgvector-backed semantic search, plus _memories_ (named, reusable retrieval configurations) that let any agent do RAG without bespoke tool wiring.
- **Agents that actually do things** — tool-calling reasoning loops with HTTP, MCP, client-side, and SOAT-platform tools, including multi-agent workflows where agents invoke other agents.
- **Sessions** — a 1-user ↔ 1-agent interface that hides actors and conversations. Two API calls take a user from message to answer.
- **Async generations** — kick off long-running agent runs, poll for status, or fire a webhook on completion.
- **Operations** — encrypted secrets, HMAC-signed webhooks with event-pattern subscriptions, and trace records for every generation.
- **MCP native** — every operation is automatically available as an MCP tool. Plug SOAT into Claude Desktop, Cursor, or any MCP-compatible runtime.

## Documentation

**[Read the full documentation](https://soat.ttoss.dev)** — quick start, key concepts, module reference, API, MCP, CLI, and SDK guides.

## Getting Started

The fastest path is Docker Compose:

```bash
git clone https://github.com/ttoss/soat.git
cd soat
```

Follow the **[Getting Started Guide](https://soat.ttoss.dev/docs/getting-started)** to bring up the server and database in under five minutes.

## Client surfaces

| Surface               | Best for                                                |
| --------------------- | ------------------------------------------------------- |
| **REST API**          | Backend services and custom integrations                |
| **MCP server**        | Claude Desktop, Cursor, and other MCP-aware AI runtimes |
| **CLI** (`soat`)      | Scripts, CI pipelines, and local exploration            |
| **SDK** (`@soat/sdk`) | TypeScript and JavaScript applications                  |

All four hit the same business logic and the same permission engine.

## Repository layout

This is a monorepo managed with pnpm and Turbo:

- `packages/server` — the SOAT server (REST + MCP, business logic, permissions)
- `packages/postgresdb` — Sequelize models and database utilities
- `packages/sdk` — TypeScript SDK generated from the OpenAPI specs
- `packages/cli` — the `soat` command-line client
- `packages/website` — the documentation site (Docusaurus)

## Contributing

Issues and pull requests are welcome. Run the tests with `pnpm --filter @soat/server test` and the smoke suite with `pnpm run -w smoke-tests`.

## License

MIT — see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [ttoss](https://ttoss.dev) — for `@ttoss/http-server` and `@ttoss/http-server-mcp`
- [pgvector](https://github.com/pgvector/pgvector) — PostgreSQL vector similarity search
- [Ollama](https://ollama.com) — local LLM and embedding models
