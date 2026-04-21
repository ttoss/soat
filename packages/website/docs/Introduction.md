---
sidebar_position: 1
---

# Introduction

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

SOAT runs as a single Node.js server backed by PostgreSQL (with [pgvector](https://github.com/pgvector/pgvector) for embeddings). It exposes two interfaces:

- **REST API** — Standard HTTP endpoints for all operations. See the [API Reference](/docs/api) for details.
- **MCP Server** — A Streamable HTTP transport that exposes the same operations as MCP tools.

### Modules

| Module                                       | Description                                             |
| -------------------------------------------- | ------------------------------------------------------- |
| [IAM](/docs/modules/iam)                     | Users, projects, API keys, and fine-grained permissions |
| [Projects](/docs/modules/projects)           | Multi-tenant project isolation and membership           |
| [Documents](/docs/modules/documents)         | Text ingestion, vector embeddings, and semantic search  |
| [Files](/docs/modules/files)                 | Binary file storage scoped to projects                  |
| [Conversations](/docs/modules/conversations) | Multi-party dialogue management with persistent history |
| [Agents](/docs/modules/agents)               | LLM-powered agents with tool calling                    |
| [AI Providers](/docs/modules/ai-providers)   | Pluggable LLM provider configuration                    |
| [Secrets](/docs/modules/secrets)             | Encrypted key-value storage scoped to projects          |
| [Chats](/docs/modules/chats)                 | Standalone chat completions                             |

## Getting Started

Head to the [Getting Started](/docs/getting-started) guide to spin up SOAT with Docker Compose in a few minutes.

## SDK

The [`@soat/sdk`](/docs/sdk) package provides a fully typed TypeScript client generated from the OpenAPI spec, so every endpoint, parameter, and response body is autocompleted in your editor.
