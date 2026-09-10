---
description: "The mental model behind SOAT and how its core resources — projects, agents, sessions, and more — fit together."
sidebar_position: 2
---

# Key Concepts

## Projects

A **project** is the primary resource boundary: AI providers, agents, files, documents, conversations, sessions, secrets, webhooks, memories, access control, API keys and trace records are project-scoped. Every call touching them needs credentials authorized for that project: a user JWT, a personal API key with the right policies, or a project-scoped API key. See [Projects](/docs/modules/projects).

## Users, IAM & Policies

| Role            | Scope   | Description                                                |
| --------------- | ------- | ---------------------------------------------------------- |
| `admin`         | Global  | Full access to all resources and all projects              |
| `project_admin` | Project | Manage members, keys, and all resources within a project   |
| `project_user`  | Project | Read and write project resources; cannot manage membership |

For finer-grained access, attach **policy documents** ([Policies](/docs/modules/policies)) to users or API keys. Policies grant or deny `resource:Action` strings such as `documents:CreateDocument` or `agents:RunAgent`, enforced identically across REST, MCP, CLI, and SDK. Evaluation rules: [IAM](/docs/modules/iam); action list: [Permissions Reference](/docs/permissions).

## Secrets & AI Providers

An **AI provider** is a project-scoped connection to an LLM service (Ollama, OpenAI, Anthropic, or any OpenAI-compatible endpoint) whose credentials are stored as encrypted [secrets](/docs/modules/secrets). Agents and chat completions reference it by ID; no credentials travel in request bodies. See [AI Providers](/docs/modules/ai-providers).

## Files, Documents & Memories — RAG building blocks

| Resource     | What it is                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| **File**     | An object stored under a path inside a project (binary or text)             |
| **Document** | A semantically searchable record extracted from a file or created directly  |
| **Memory**   | A named container for memory entries that stores durable context for agents |

Documents and memory entries are embedded with pgvector and queryable by semantic similarity. Agents retrieve them through [knowledge search](/docs/modules/knowledge) via `knowledge_config` and write facts via memory-aware tools. See [Files](/docs/modules/files), [Documents](/docs/modules/documents), [Memories](/docs/modules/memories).

## Three ways to talk to a model

| Layer       | What it is                                                      | Use it when                                              |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| **Chat**    | Raw LLM completion. No agent, no tools, you manage history.     | One-shot completions, custom inference flows             |
| **Agent**   | Reasoning-and-acting loop with tools, step rules, and policies. | Tool-calling, multi-step tasks, MCP-backed assistants    |
| **Session** | 1 user ↔ 1 agent. Conversation, actors, and history hidden.     | Default user-facing flow — two API calls and you're done |

Sessions are a top-level resource (`/sessions`, tied to an agent via `agent_id`) built on [conversations](/docs/modules/conversations); use the conversation API directly for multi-party dialogue. See [Chats](/docs/modules/chats), [Agents](/docs/modules/agents), [Sessions](/docs/modules/sessions).

## Agents & tools

An **agent** is a named, reusable assistant in a project: an AI provider reference, instructions, and tools. Four tool types:

- **`http`** — call any HTTP endpoint
- **`mcp`** — connect to an external MCP server
- **`client`** — pause for client-side execution and resume with the result
- **`builtin`** — call SOAT platform actions, including invoking other agents

Tools are shared across agents. The reasoning loop is controlled by `tool_choice`, `step_rules`, `active_tool_ids`, `boundary_policy`, and `max_steps`. Generations are **asynchronous by default**: start one, poll for status, or receive a webhook on completion.

## Agent Formations

[Agent Formations](/docs/modules/formations): a template declares providers, memories, tools, agents, and related resources; SOAT resolves references, provisions in dependency order, and logs operations and events for each create, update, or delete.

## Observability

Every generation produces a **trace** record with the model, tool calls, durations, and finish reason. Project-scoped [webhooks](/docs/modules/webhooks) (HMAC-signed, retried up to three times) feed external observability and event pipelines.

## Resource hierarchy at a glance

```
SOAT instance
├── Users, Policies, API keys (global)
└── Project
    ├── Members (users with roles)
    ├── Project keys (API keys scoped to the project)
    ├── Secrets (encrypted values)
    ├── AI Providers (LLM connections)
    ├── Agent tools (http, mcp, client, soat)
    ├── Agent formations
    ├── Agents
    │   └── Sessions → Messages
    ├── Files
    ├── Documents (pgvector RAG chunks)
    ├── Memories → Entries
    ├── Conversations → Messages
    ├── Chats
    └── Webhooks
```

## CLI flag mapping

REST fields become kebab-case flags; path parameters keep resource-specific names (`--project-id`, `--agent-id`, `--session-id`, `--conversation-id`, `--file-id`), never a generic `--id`. Full surface: [CLI commands reference](/docs/cli/commands).

## What's next

| Topic                                       | Description                          |
| ------------------------------------------- | ------------------------------------ |
| [Choosing a Client Surface](/docs/client-surfaces) | REST, SDK, CLI or MCP |
| [The Layers of an Agent System](/docs/agent-system-layers) | Which layer and modules own a failure; how a change is proven an improvement |
| [Configuration](/docs/self-hosting/configuration)          | Production environment variables     |
| [Platform modules](/docs/modules)           | Deep-dives into every resource type  |
| [API Reference](/docs/api)                  | OpenAPI-generated endpoint reference |
