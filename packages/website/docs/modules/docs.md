---
description: "MCP-only tools that give agents direct access to SOAT platform documentation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Docs

MCP-only tools that give agents direct access to SOAT platform documentation.

## Overview

Two MCP tools, `get-docs` and `get-doc-page`, let agents discover and read SOAT documentation from the published site (`soat.ttoss.dev/llms.txt` and pages) without a web fetch tool.

They are registered in the MCP server, not backed by REST endpoints. The base URL defaults to `https://soat.ttoss.dev`; override with `SOAT_DOCS_BASE_URL` for self-hosted deployments.

`SOAT_DOCS_BASE_URL` also rebases the error envelope's `docs_url` and the `errors.json` link in the default `hint` (see [Error Codes](../error-codes.md)), so a deployment relaying SOAT errors can point both at its own documentation.

## Access

**Not project-scoped, no IAM action**: they read only public documentation. Any authenticated MCP client can call them; there is no `resource:Action` permission and no entry in the [Permissions Reference](../permissions.md).

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `SOAT_DOCS_BASE_URL` | No | Base URL of the SOAT documentation site. Defaults to `https://soat.ttoss.dev`. Also rebases the `hint` and `docs_url` fields on every error response — see [Error Codes](../error-codes.md). |

## Data Model

Stateless; each tool returns Markdown fetched live.

| Tool | Input | Output |
| --- | --- | --- |
| `get-docs` | _(none)_ | The documentation index in `llms.txt` format — Markdown listing every available page and its URL. |
| `get-doc-page` | `url` (`string`, required) — full URL of a page, as returned by `get-docs` | The full Markdown content of that page. |

The `url` passed to `get-doc-page` must belong to the SOAT documentation site; other hosts are rejected.

## MCP Tools

### `get-docs`

The documentation index (`llms.txt`): every page and its URL. Call first to discover topics.

### `get-doc-page`

Full content of one page; the URL must be from the SOAT documentation site (as returned by `get-docs`).

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
