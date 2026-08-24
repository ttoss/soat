---
title: Developers
description: Every SOAT developer entry point in one place — API reference, OpenAPI specs, SDK, CLI, MCP server, error catalog, and how to get a key.
---

# Developers

Everything needed to build against SOAT, in one page. SOAT is self-hosted: you
run the server, so there is no key to request and no environment to be granted.
Getting to a first API call is `docker compose up -d` plus one bootstrap call.

## Start here

- [Quick start](/docs/getting-started) — Compose file, first admin,
  first agent, in a few minutes
- [Core concepts](/docs/getting-started/concepts) — projects, agents, sessions,
  policies, and how they fit together
- [Tutorials](/docs/tutorials/permissions) — end-to-end walkthroughs, each one
  executed in CI so the commands stay correct
- [Self-hosting configuration](/docs/self-hosting/configuration) — every
  environment variable the server reads

## Four ways in, one API

The REST API is the contract. The MCP tool surface, the TypeScript SDK, and the
CLI are all generated from the same OpenAPI documents, so an operation that
exists in one exists in all of them, with the same field names.

| Surface | Reference | Use it when |
| --- | --- | --- |
| REST | [API reference](/docs/api) | You are calling SOAT over HTTP from anything |
| MCP | [MCP server](/docs/mcp) | You want Claude, Cursor, or VS Code to call SOAT as tools |
| SDK | [`@soat/sdk`](/docs/sdk) | You are writing TypeScript |
| CLI | [`soat`](/docs/cli) | You are scripting, or exploring from a shell |

## Machine-readable specs

These are the files to point a code generator, an agent, or your own tooling at:

| File | What it is |
| --- | --- |
| [openapi.json](https://soat.ttoss.dev/openapi.json) | Every REST operation, schema, and security scheme in one OpenAPI 3.0 document |
| [openapi.yaml](https://soat.ttoss.dev/openapi.yaml) | The same document in YAML |
| [Per-module specs](/docs/openapi-specs) | One YAML per module, for a narrower surface |
| [errors.json](https://soat.ttoss.dev/errors.json) | Every error code, its HTTP status, and what to do about it |
| [agents.md](https://soat.ttoss.dev/agents.md) | Instructions for an agent deciding whether and how to call SOAT |
| [llms.txt](https://soat.ttoss.dev/llms.txt) | Index of every documentation page, one line each |
| [llms-full.txt](https://soat.ttoss.dev/llms-full.txt) | The whole prose corpus in one file, ready to chunk and embed |

Every documentation page also has a Markdown twin: append `.md` to its URL, or
send `Accept: text/markdown` to the page itself.

## Authentication and keys

Credentials are self-serve, because you own the deployment. `users/bootstrap`
creates the first admin and then closes for good; from there you mint
project-scoped `sk_…` API keys with exactly the actions of the policy you
attach, and rotate them in place.

For MCP clients, SOAT runs a full OAuth 2.1 authorization server: clients
discover it at `/.well-known/oauth-authorization-server` (RFC 8414) and
`/.well-known/oauth-protected-resource` (RFC 9728), and register themselves
(RFC 7591) with no operator step.

- [API keys](/docs/modules/api-keys) — scoping, rotation, and revocation
- [Permissions reference](/docs/permissions) — every action a policy can grant
- [Connecting an MCP client](/docs/mcp/connecting) — the OAuth flow end to end

## Conventions worth knowing before you write code

- **snake_case on the wire**, everywhere — REST, MCP, webhooks, and the audit
  export. Unknown fields are rejected rather than ignored, so a typo fails loudly.
- **Structured errors.** Every failure answers
  `{ "error": { "code", "message", "hint", "docs_url" } }`. Branch on `code`,
  act on `hint`.
- **One toggle for long work.** Anything that can outlast a request takes `wait`,
  defaulting to background: you get a handle to poll, or pass `wait=true` to
  block. See [Sync and async](/docs/advanced/sync-and-async).
- **Uniform pagination.** Every list endpoint takes `limit` and `offset` and
  returns the same envelope.
- **URL-versioned API.** Every route lives under `/api/v1`.

## Sandbox

There is no separate sandbox tier to request: a local instance *is* the product.
Run it with the Compose file from the quick start — PostgreSQL with pgvector, a
local Ollama for models, and the server on port 5047 — and the whole platform
works offline with no third-party credential. Throwaway projects, seeded data,
and destructive tests all run against your own deployment; delete the volumes to
reset.

## Source and support

SOAT is Apache-2.0 and developed in the open at
[github.com/ttoss/soat](https://github.com/ttoss/soat). Ask questions in
[Discussions](https://github.com/ttoss/soat/discussions), file bugs in
[Issues](https://github.com/ttoss/soat/issues), and report vulnerabilities
[privately](https://github.com/ttoss/soat/security/advisories/new). See
[Contact](/contact) for which channel fits what.
