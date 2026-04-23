---
sidebar_position: 2
---

# Key Concepts

Before diving into modules and API calls, this page explains the mental model behind SOAT and how its core resources relate to each other.

## Projects

A **project** is the primary resource boundary in SOAT. All resources — AI providers, agents, files, secrets, conversations — belong to a project. Access control, API keys, and billing are all scoped to projects.

Every API call that touches project-owned resources must carry credentials authorized for that project (a user JWT with membership, or a project API key).

See the [Projects module](/docs/modules/projects) for the full data model and permission rules.

## Users and IAM

SOAT uses a role-based access control model:

| Role            | Scope   | Description                                                |
| --------------- | ------- | ---------------------------------------------------------- |
| `admin`         | Global  | Full access to all resources and all projects              |
| `project_admin` | Project | Manage members, keys, and all resources within a project   |
| `project_user`  | Project | Read and write project resources; cannot manage membership |

Users are created globally and then added to projects with a role. A user can belong to multiple projects with different roles in each.

See the [IAM module](/docs/modules/iam) for details.

## AI Providers

An **AI provider** is a configured connection to an LLM service — Ollama, OpenAI, Anthropic, or any OpenAI-compatible endpoint. Providers are scoped to a project and store their API key as an encrypted [secret](/docs/modules/secrets).

When you register a provider, SOAT stores its base URL, model name, and authentication details so agents and chat endpoints can reference it by ID without embedding credentials in every request.

See the [AI Providers module](/docs/modules/ai-providers) for configuration options.

## Agents

An **agent** is a named, reusable AI assistant defined within a project. It references an AI provider, carries a system prompt, and can be extended with tools (HTTP calls, MCP servers, or client-side tool execution).

Every [conversation](/docs/modules/conversations) is tied to an agent. The agent's system prompt and tools are applied automatically at generation time.

See the [Agents module](/docs/modules/agents) for the full configuration reference.

## Resource Hierarchy

```
SOAT instance
└── Project
    ├── Members (users with roles)
    ├── Project Keys (API keys scoped to the project)
    ├── Secrets (encrypted values)
    ├── AI Providers (LLM connections)
    ├── Agents (AI assistants with tools)
    ├── Files
    ├── Documents (RAG chunks)
    └── Conversations → Messages
```

## What's Next

| Topic                                       | Description                          |
| ------------------------------------------- | ------------------------------------ |
| [Advanced Configuration](./advanced-config) | Production environment variables     |
| [Modules](/docs/modules/iam)                | Deep-dives into every resource type  |
| [API Reference](/docs/api)                  | OpenAPI-generated endpoint reference |
