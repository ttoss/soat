import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Docs

MCP-only tools that give agents direct access to SOAT platform documentation.

## Overview

The Docs module exposes two MCP tools — `get-docs` and `get-doc-page` — that allow agents to discover and read SOAT documentation without needing a separate web fetch tool. The tools fetch content directly from the published documentation site (`soat.ttoss.dev/llms.txt` and individual pages).

These tools are registered directly in the MCP server and are not backed by REST API endpoints. The documentation base URL defaults to `https://soat.ttoss.dev` and can be overridden via the `SOAT_DOCS_BASE_URL` environment variable for self-hosted deployments.

## Access

The Docs tools are **not project-scoped and carry no IAM action** — they read only public documentation, never project data. Any authenticated MCP client can call them; there is no `resource:Action` permission to grant and no entry in the [Permissions Reference](../permissions.md).

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `SOAT_DOCS_BASE_URL` | No | Base URL of the SOAT documentation site. Defaults to `https://soat.ttoss.dev`. |

## Data Model

The module is stateless — it stores nothing and returns documentation content fetched live from the documentation site. Each tool takes the input below and returns Markdown text.

| Tool | Input | Output |
| --- | --- | --- |
| `get-docs` | _(none)_ | The documentation index in `llms.txt` format — Markdown listing every available page and its URL. |
| `get-doc-page` | `url` (`string`, required) — full URL of a page, as returned by `get-docs` | The full Markdown content of that page. |

The `url` passed to `get-doc-page` must belong to the SOAT documentation site; other hosts are rejected.

## MCP Tools

### `get-docs`

Returns the SOAT documentation index in `llms.txt` format — a Markdown document listing all available documentation pages with their URLs. Use this first to discover what topics are available.

### `get-doc-page`

Fetches the full content of a specific documentation page by URL. The URL must be from the SOAT documentation site (as returned by `get-docs`).

## Examples

<Tabs groupId="client">
<TabItem value="mcp" label="MCP (JSON-RPC)">

```json
// Get the documentation index
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get-docs",
    "arguments": {}
  }
}

// Get a specific page
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get-doc-page",
    "arguments": {
      "url": "https://soat.ttoss.dev/docs/modules/agents"
    }
  }
}
```

</TabItem>
</Tabs>
