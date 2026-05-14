---
sidebar_position: 2
---

# Key Concepts

This page explains the mental model behind SOAT and how its core resources fit together. Read it once and the rest of the documentation will feel obvious.

## Projects

A **project** is the primary resource boundary. Almost everything — AI providers, agents, files, documents, conversations, sessions, secrets, webhooks, memories — belongs to a project. Access control, API keys, and trace records are all scoped to projects.

Every API call that touches project-owned resources must carry credentials authorized for that project: a user JWT, a personal API key with the right policies, or a project-scoped API key.

See the [Projects module](/docs/modules/projects).

## Users, IAM & Policies

SOAT uses a role-based + policy-based access model.

| Role            | Scope   | Description                                                |
| --------------- | ------- | ---------------------------------------------------------- |
| `admin`         | Global  | Full access to all resources and all projects              |
| `project_admin` | Project | Manage members, keys, and all resources within a project   |
| `project_user`  | Project | Read and write project resources; cannot manage membership |

Roles cover the common cases. For finer-grained access, attach **policy documents** ([Policies module](/docs/modules/policies)) to users or API keys. Policies grant or deny specific `resource:Action` strings such as `documents:CreateDocument` or `agents:RunAgent`. The same permission is enforced across REST, MCP, CLI, and SDK.

See the [IAM module](/docs/modules/iam) for the evaluation rules and [Permissions Reference](/docs/permissions) for the full action list.

## Secrets & AI Providers

An **AI provider** is a configured connection to an LLM service — Ollama, OpenAI, Anthropic, or any OpenAI-compatible endpoint. Providers are scoped to a project and store their credentials as encrypted [secrets](/docs/modules/secrets).

Once a provider is registered, agents and chat completions reference it by ID. No credentials in request bodies, no environment-variable juggling per agent.

See [AI Providers](/docs/modules/ai-providers) and [Secrets](/docs/modules/secrets).

## Files, Documents & Memories — RAG building blocks

| Resource     | What it is                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| **File**     | An object stored under a path inside a project (binary or text)             |
| **Document** | A semantically searchable record extracted from a file or created directly  |
| **Memory**   | A named container for memory entries that stores durable context for agents |

Documents and memory entries are embedded with pgvector and queryable by semantic similarity. Agents can retrieve this context through [knowledge search](/docs/modules/knowledge) using `knowledge_config` and can write new facts via memory-aware tools.

See [Files](/docs/modules/files), [Documents](/docs/modules/documents), and [Memories](/docs/modules/memories).

## Three ways to talk to a model

SOAT exposes three layers, from lowest to highest level:

| Layer       | What it is                                                      | Use it when                                              |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| **Chat**    | Raw LLM completion. No agent, no tools, you manage history.     | One-shot completions, custom inference flows             |
| **Agent**   | Reasoning-and-acting loop with tools, step rules, and policies. | Tool-calling, multi-step tasks, MCP-backed assistants    |
| **Session** | 1 user ↔ 1 agent. Conversation, actors, and history hidden.     | Default user-facing flow — two API calls and you're done |

Sessions are nested under agents (`/agents/:agent_id/sessions`) and use [conversations](/docs/modules/conversations) under the hood. Drop into the conversation API directly when you need multi-party dialogue or full control.

See [Chats](/docs/modules/chats), [Agents](/docs/modules/agents), [Sessions](/docs/modules/sessions), and [Conversations](/docs/modules/conversations).

## Agents & tools

An **agent** is a named, reusable AI assistant inside a project. It references an AI provider, carries instructions, and is extended with tools. SOAT supports four tool types:

- **`http`** — call any HTTP endpoint
- **`mcp`** — connect to an external MCP server
- **`client`** — pause for client-side execution and resume with the result
- **`soat`** — call SOAT platform actions (including invoking other agents — multi-agent workflows)

Tools are first-class resources, shareable across agents. Agents support `tool_choice`, `step_rules`, `active_tool_ids`, `boundary_policy`, and `max_steps` for fine-grained control over the reasoning loop.

Generations are **asynchronous by default**: kick one off, poll for status, or hand off to a webhook when it completes.

## Agent Formations

When you need reproducible deployments, use [Agent Formations](/docs/modules/agent-formations). A formation template declares providers, memories, tools, agents, and related resources in one place. SOAT resolves references, provisions resources in dependency order, and stores an operation/event log for each create, update, or delete.

## Observability

Every generation produces a **trace** record with the model, tool calls, durations, and finish reason. Combined with project-scoped webhooks (HMAC-signed, retried up to three times), this gives you the hooks you need to wire SOAT into existing observability and event pipelines.

See [Webhooks](/docs/modules/webhooks).

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

The CLI exposes REST fields as kebab-case flags. Body and query fields mirror the REST contract; path parameters keep resource-specific names. Commands use flags such as `--project-id`, `--agent-id`, `--session-id`, `--conversation-id`, and `--file-id` instead of a generic `--id`.

See the [CLI commands reference](/docs/cli/commands) for the full surface.

## What's next

| Topic                                       | Description                          |
| ------------------------------------------- | ------------------------------------ |
| [Advanced Configuration](./advanced-config) | Production environment variables     |
| [Modules](/docs/modules/iam)                | Deep-dives into every resource type  |
| [API Reference](/docs/api)                  | OpenAPI-generated endpoint reference |
