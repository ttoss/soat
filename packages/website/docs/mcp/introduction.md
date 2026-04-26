---
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

Obtain a session token by calling `POST /api/v1/users/login`. Obtain a project-scoped API key by calling `POST /api/v1/project-keys`. See [Projects module](/docs/modules/projects#project-keys) for details.

## Available Modules

Every SOAT module is exposed through the MCP server. See the [Tools Reference](./tools.md) for the complete list.
