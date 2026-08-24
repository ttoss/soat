---
title: About SOAT
description: What SOAT is, who maintains it, how it is licensed, and how it is developed.
---

# About SOAT

SOAT is open-source infrastructure for production-ready AI agents. It is a single
Node.js server, backed by PostgreSQL and pgvector, that supplies the parts an
agent needs once it leaves a notebook: durable sessions and conversations,
multi-agent orchestration, knowledge retrieval over your own documents,
long-lived memory, guardrails, IAM, quotas, and traces.

It is **self-hosted software, not a SaaS**. There is no hosted control plane and
no account to create: you run the server and the database, and SOAT calls
whichever model provider you configure — OpenAI, Anthropic, Google, Bedrock,
Ollama, or any OpenAI-compatible endpoint. This site,
[soat.ttoss.dev](https://soat.ttoss.dev), serves documentation only; there is no
API behind this domain.

## What it is for

SOAT earns its place once state, permissions, retrieval, or evidence are
involved. A single stateless completion is better served by calling a provider
directly. The [agent instructions](https://soat.ttoss.dev/agents.md) state the boundary precisely,
including the cases where SOAT is the wrong answer.

Everything is reachable four ways — the REST API, the MCP endpoint, the
`@soat/sdk` TypeScript client, and the `soat` CLI — all generated from the same
OpenAPI documents, so an operation that exists in one exists in all of them.

## Who maintains it

SOAT is built and maintained by
[Terezinha Tech Operations (ttoss)](https://ttoss.dev), a small team that
develops it in the open. Development happens entirely on GitHub: issues, pull
requests, and design discussions are public, and releases are published to npm
and Docker Hub from CI.

## License and trademark

SOAT is released under the
[Apache License 2.0](https://github.com/ttoss/soat/blob/main/LICENSE). You may
run it commercially, modify it, and deploy it privately without asking anyone.
The name and logo are covered separately by the
[trademark policy](https://github.com/ttoss/soat/blob/main/TRADEMARK.md).

## Where to go next

- [Documentation](/docs/introduction) — concepts, modules, and tutorials
- [Developer entry points](/developers) — API, SDK, CLI, MCP, and specs in one place
- [Contact](/contact) — how to reach the maintainers
- [Source on GitHub](https://github.com/ttoss/soat)
