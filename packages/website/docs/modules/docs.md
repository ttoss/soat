import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Docs

The Docs module gives authenticated users and agents direct access to SOAT platform documentation.

## Overview

The Docs module exposes the SOAT Markdown documentation through the REST API and MCP. Agents can call `list-docs` to discover available pages and `get-doc-content` to fetch the full Markdown content of any page — without needing external internet access or a web fetch tool.

Documentation pages are read from the directory configured by the `DOCS_PATH` environment variable (default: `packages/website/docs` from the workspace root).

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `DOCS_PATH` | No | Absolute path to the directory containing Markdown documentation files. Defaults to `packages/website/docs` relative to the workspace root. |

## Data Model

### DocPage

Returned by `GET /api/v1/docs` (list endpoint).

| Field | Type | Description |
| --- | --- | --- |
| `path` | `string` | Relative path of the page without the `.md` extension (e.g. `modules/agents`) |
| `title` | `string` | Title extracted from the first `#` heading in the file |
| `description` | `string` | Short description extracted from the first paragraph after the title (max 300 chars) |

### DocContent

Returned by `GET /api/v1/docs/content`.

| Field | Type | Description |
| --- | --- | --- |
| `path` | `string` | Relative path of the page |
| `title` | `string` | Title extracted from the first `#` heading |
| `content` | `string` | Full raw Markdown content of the page |

## Examples

<Tabs groupId="client">
<TabItem value="cli" label="CLI">

```bash
# List all documentation pages
soat list-docs

# Get the content of the Agents module doc
soat get-doc-content --path modules/agents
```

</TabItem>
<TabItem value="sdk" label="SDK">

```typescript
import { createClient } from '@soat/sdk';

const client = createClient({ baseUrl: 'http://localhost:5047' });

// List all docs
const pages = await client.GET('/api/v1/docs');

// Get content of a specific page
const doc = await client.GET('/api/v1/docs/content', {
  params: { query: { path: 'modules/agents' } },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# List all docs
curl -H "Authorization: Bearer $TOKEN" http://localhost:5047/api/v1/docs

# Get content of a specific page
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5047/api/v1/docs/content?path=modules/agents"
```

</TabItem>
</Tabs>
