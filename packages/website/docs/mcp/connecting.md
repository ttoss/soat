---
sidebar_position: 2
---

# Connecting an MCP Client

SOAT's MCP endpoint uses Streamable HTTP transport. Most modern MCP clients support this transport.

## Prerequisites

- A running SOAT server (default port `5047`)
- A valid Bearer token — either a JWT session token or an `sk_`-prefixed project key

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

> `mcp-remote` is a lightweight proxy that bridges the SSE transport expected by Claude Desktop to the Streamable HTTP transport used by SOAT. Install it automatically via `npx`.

## VS Code (GitHub Copilot / MCP extension)

Add the following to your VS Code `settings.json` or `.vscode/mcp.json`:

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

Any client that supports Streamable HTTP transport can connect directly:

```bash
curl -X POST http://localhost:5047/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Using Project Keys

For long-lived or machine-to-machine access, use a project-scoped API key instead of a session token:

1. Create a key via `POST /api/v1/project-keys` — the response includes the raw `sk_`-prefixed key (shown once only).
2. Pass it as the Bearer token: `Authorization: Bearer sk_...`

Project keys are scoped to a project and inherit project-level permissions. See [Projects module](/docs/modules/projects) for details.
