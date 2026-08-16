---
description: "SOAT exposes every resource as Model Context Protocol (MCP) tools that Claude, Copilot, and any MCP client can call directly."
sidebar_position: 1
slug: /mcp
---

# MCP Server

SOAT exposes all its resources as [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) tools. AI assistants such as Claude Desktop, GitHub Copilot, and any MCP-compatible client can call these tools to manage projects, files, agents, conversations, documents, and more directly from a chat or coding session.

## Endpoint

```
POST http://<your-server>:5047/mcp
```

The MCP server is mounted on the same port as the REST API. No separate process or port is required.

## Protocol Details

| Property     | Value                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| Transport    | Streamable HTTP (JSON responses)                                                      |
| HTTP methods | `POST /mcp` — send JSON-RPC requests/notifications; `DELETE /mcp` — terminate session |
| Content-Type | `application/json`                                                                    |
| Accept       | `application/json, text/event-stream`                                                 |
| Session mode | Stateless (a fresh transport is created per HTTP request)                             |

The server implements the MCP specification over HTTP with `enableJsonResponse: true`. There is no SSE streaming — every response is a plain JSON body.

## Authentication

All tools require authentication. Pass either a JWT session token or an `sk_`-prefixed API key as a Bearer token in the `Authorization` header of every MCP request:

```
Authorization: Bearer <token>
```

Obtain a session token by calling [`POST /api/v1/users/login`](/docs/api/users/login-user). Obtain a project-scoped API key by calling [`POST /api/v1/api-keys`](/docs/api/api-keys/create-api-key). See [Projects module](/docs/modules/projects) for details.

Authenticating admits you to the MCP surface; it does not authorize the action. Every tool call is evaluated against the caller's policies at call time, so a token that can reach `/mcp` still gets a permission error from any tool its policies do not allow.

## How a Tool Call Is Served

A tool call runs **inside the server process**. The MCP server dispatches the request through the same middleware stack and route handler that serves the equivalent REST call, so permission checks, field validation, audit logging, request metering, quotas, and the snake_case response contract all apply identically — a tool call and a REST call are the same request, differing only in how they arrived.

Nothing about a tool call depends on the server being reachable over the network from itself.

A tool call that fails is returned as an **error**, never as a result: a permission denial or a missing resource surfaces the API's own error message, so an assistant cannot mistake a rejection for data. An action that answers `204 No Content` — every `delete-*` — returns an empty result.

## What Is Not Exposed as a Tool

A tool call is a single request that returns a single JSON value. A few REST operations cannot be expressed that way, so they are deliberately absent from the tool list rather than offered and failed on use:

| Operation                                | Why                                                | Use instead                              |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `download-file`                          | Streams raw bytes, which have no JSON form          | `download-file-base64`                   |
| `export-audit-entries`                   | Streams an unbounded NDJSON dump                    | `list-audit-entries` (paged)             |
| `stream: true` on `create-agent-generation` | Server-sent events need a channel a tool call lacks | the same tool without `stream`           |

All of these remain fully available over REST, the SDK, and the CLI, where the caller controls where the bytes go.

## Available Modules

Every SOAT module is exposed through the MCP server. See the [Tools Reference](./tools.md) for the complete list.
