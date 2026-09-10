---
description: "How to connect an MCP client to SOAT's Streamable HTTP endpoint."
sidebar_position: 2
---

# Connecting an MCP Client

## Prerequisites

- A running SOAT server (default port `5047`)
- A valid Bearer token — either a JWT session token or an `sk_`-prefixed project key

## Claude (OAuth connector)

Remote MCP connectors (e.g. Claude's custom connectors) authenticate via OAuth;
no provisioned token is needed. Add the server by URL:

```
https://<your-soat-host>/mcp
```

The endpoint challenges every request (including `initialize`) with `401` +
`WWW-Authenticate`. The client discovers the authorization server via
`/.well-known/oauth-protected-resource`, registers dynamically, and runs the
authorize + PKCE flow against the SOAT consent screen; after you pick a project
and grant permissions it receives a scoped access token and the tools appear.
Full flow: [OAuth](/docs/modules/oauth).

> Tools are listed only **after** OAuth completes. A connector that never
> prompts for sign-in and reports "no tools available" is not talking to SOAT's
> endpoint.

## Claude Desktop

Add a server entry to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "soat": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:5047/mcp",
        "--header",
        "Authorization: Bearer ${SOAT_TOKEN}"
      ],
      "env": {
        "SOAT_TOKEN": "<your-bearer-token>"
      }
    }
  }
}
```

> `mcp-remote` bridges the SSE transport Claude Desktop expects to Streamable HTTP.

## VS Code (GitHub Copilot / MCP extension)

In `settings.json` or `.vscode/mcp.json`:

```json
{
  "servers": {
    "soat": {
      "type": "http",
      "url": "http://localhost:5047/mcp",
      "headers": {
        "Authorization": "Bearer ${input:soat_token}"
      }
    }
  }
}
```

## Generic HTTP client

```bash
curl -X POST http://localhost:5047/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Using Project Keys

For long-lived or machine-to-machine access:

1. Create a key via `POST /api/v1/project-keys`; the response includes the raw `sk_`-prefixed key (shown once).
2. Pass it as the Bearer token: `Authorization: Bearer sk_...`

Project keys inherit project-level permissions ([Projects](/docs/modules/projects)).
