import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Docs

MCP-only tools that give agents direct access to SOAT platform documentation.

## Overview

The Docs module exposes two MCP tools — `get-docs` and `get-doc-page` — that allow agents to discover and read SOAT documentation without needing a separate web fetch tool. The tools fetch content directly from the published documentation site (`soat.ttoss.dev/llms.txt` and individual pages).

These tools are registered directly in the MCP server and are not backed by REST API endpoints. They are available to any authenticated MCP client.

The documentation base URL defaults to `https://soat.ttoss.dev` and can be overridden via the `SOAT_DOCS_BASE_URL` environment variable for self-hosted deployments.

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `SOAT_DOCS_BASE_URL` | No | Base URL of the SOAT documentation site. Defaults to `https://soat.ttoss.dev`. |

## MCP Tools

### `get-docs`

Returns the SOAT documentation index in `llms.txt` format — a Markdown document listing all available documentation pages with their URLs. Use this first to discover what topics are available.

### `get-doc-page`

Fetches the full content of a specific documentation page by URL. The URL must be from the SOAT documentation site (as returned by `get-docs`).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | Full URL of the documentation page |

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
