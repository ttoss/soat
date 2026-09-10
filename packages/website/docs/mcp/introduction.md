---
description: "SOAT exposes every resource as Model Context Protocol (MCP) tools that Claude, Copilot, and any MCP client can call directly."
sidebar_position: 1
slug: /mcp
---

# MCP Server

SOAT exposes every resource as [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) tools for Claude Desktop, GitHub Copilot, and any MCP-compatible client.

## Endpoint

```
POST http://<your-server>:5047/mcp
```

## Protocol Details

| Property     | Value                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| Transport    | Streamable HTTP (JSON responses)                                                      |
| HTTP methods | `POST /mcp` — send JSON-RPC requests/notifications; `DELETE /mcp` — terminate session |
| Content-Type | `application/json`                                                                    |
| Accept       | `application/json, text/event-stream`                                                 |
| Session mode | Stateless (a fresh transport is created per HTTP request)                             |

`enableJsonResponse: true`: no SSE streaming, every response is a plain JSON body. Same port and process as the REST API.

## Authentication

Every MCP request carries a JWT session token or an `sk_`-prefixed API key as a Bearer token:

```
Authorization: Bearer <token>
```

Session token: [`POST /api/v1/users/login`](/docs/api/users/login-user). Project-scoped API key: [`POST /api/v1/api-keys`](/docs/api/api-keys/create-api-key) ([Projects module](/docs/modules/projects)).

Authentication admits the caller to `/mcp`; every tool call is still evaluated against the caller's policies at call time.

## How a Tool Call Is Served

A tool call runs **inside the server process**, through the same middleware stack and route handler as the REST call: permission checks, field validation, audit logging, request metering, quotas, and the snake_case response contract apply identically; the server never reaches itself over the network. A failed tool call is returned as an **error**, never a result, carrying the API's own error message. An action that answers `204 No Content` (every `delete-*`) returns an empty result.

## What Is Not Exposed as a Tool

A tool call returns one JSON value; REST operations that cannot are absent:

| Operation                                | Why                                                | Use instead                              |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `download-file`                          | Streams raw bytes, which have no JSON form          | `download-file-base64`                   |
| `export-audit-entries`                   | Streams an unbounded NDJSON dump                    | `list-audit-entries` (paged)             |
| `stream: true` on `create-agent-generation` | Server-sent events need a channel a tool call lacks | the same tool without `stream`           |

All remain available over REST, the SDK, and the CLI.

## Available Modules

Every module is exposed. Complete list: [Tools Reference](./tools.md).
