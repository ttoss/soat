---
title: Platform
sidebar_label: Platform Overview
---

# Platform

SOAT's functionality is organized into **modules** — named resources exposed through the [REST API](/docs/api), the [MCP server](/docs/mcp), the [CLI](/docs/cli), and the [SDK](/docs/sdk). Each module page describes what the resource does, its data model, key concepts, and usage examples on every client surface.

The modules fall into six groups:

## Identity & Access

Who can do what, and with which credentials.

- [Users](./users.md) — accounts, roles, and authentication
- [Projects](./projects.md) — the primary resource boundary; almost everything belongs to a project
- [IAM & Policies](./iam.md) — how permissions are evaluated
- [Policies](./policies.md) — reusable policy documents granting `resource:Action` permissions
- [API Keys](./api-keys.md) — project-scoped and personal keys with policy attachments
- [OAuth](./oauth.md) — the OAuth flow used by MCP connectors

## Storage & Retrieval

Project-scoped data and semantic search.

- [Files](./files.md) — binary file storage
- [Documents](./documents.md) — structured text content with ingestion
- [Embeddings](./embeddings.md) — pgvector embeddings and semantic search
- [Ingestion Rules](./ingestion-rules.md) — automatic processing of uploaded content
- [Knowledge](./knowledge.md) — unified search across documents and memory entries
- [Memories](./memories.md) — durable context stores for agents

## Agents & Conversations

The generation engine and its building blocks.

- [AI Providers](./ai-providers.md) — LLM provider connections and models
- [Agents](./agents.md) — configurable agents with tools and multi-step reasoning
- [Tools](./tools.md) — HTTP, MCP, client-side, and SOAT-platform tools
- [Sessions](./sessions.md) — the 1↔1 user/agent interface
- [Conversations](./conversations.md) — the multi-party message engine
- [Chats](./chats.md) — raw LLM completions without an agent
- [Actors](./actors.md) — participant identities in conversations
- [Generations](./generations.md) — generation records and async jobs

## Orchestration & Automation

Composing agents into workflows and reacting to events.

- [Orchestrations](./orchestrations.md) — deterministic multi-agent graphs with typed state
- [Discussions](./discussions.md) — structured multi-agent panel discussions
- [Triggers](./triggers.md) — scheduled and on-demand flow execution
- [Webhooks](./webhooks.md) — HMAC-signed event delivery to external systems

## Declarative Deployment

- [Formations](./formations.md) — define full agent stacks (providers, memories, tools, agents) in JSON/YAML and deploy them with dependency-aware provisioning. See the [Formation Types reference](/docs/formations-types) for every resource type.

## Operations

Observability and runtime configuration.

- [Traces](./traces.md) — per-generation trace records: tool calls, latency, token usage
- [Usage](./usage.md) — usage metering and pricing
- [Secrets](./secrets.md) — encrypted secrets for provider keys and tool credentials
- [Docs](./docs.md) — MCP-only tools that give agents access to SOAT documentation

---

See the [Permissions Reference](/docs/permissions) for the full list of IAM action strings across all modules.
