---
description: "Encrypted storage for sensitive values such as API keys and credentials in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Secrets

Encrypted storage for sensitive values such as API keys and credentials.

## Overview

Secrets are associated with a project. Values are encrypted at rest using AES-256-GCM and are **never returned** by any API response. Once stored, a secret's value can only be replaced. All operations return a `has_value` boolean to indicate whether an encrypted value is on file.

Secrets can be linked to [AI Providers](./ai-providers.md) to supply credentials at inference time. See it end to end in [Connect Third-Party LLMs - Step 3 (Store provider credentials as secrets)](/docs/tutorials/connect-third-party-llms#step-3--store-provider-credentials-as-secrets) and [Step 4 (Create provider records)](/docs/tutorials/connect-third-party-llms#step-4--create-provider-records).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Connect Third-Party LLMs - Step 3 (Store provider credentials as secrets)](/docs/tutorials/connect-third-party-llms#step-3--store-provider-credentials-as-secrets)
- [Connect Third-Party LLMs - Step 4 (Create provider records)](/docs/tutorials/connect-third-party-llms#step-4--create-provider-records)

## Data Model

| Field        | Type    | Description                              |
| ------------ | ------- | ---------------------------------------- |
| `id`         | string  | Public identifier (e.g. `sec_…`)         |
| `project_id` | string  | ID of the owning project                 |
| `name`       | string  | Human-readable label                     |
| `has_value`  | boolean | `true` when an encrypted value is stored |
| `created_at` | string  | ISO 8601 creation timestamp              |
| `updated_at` | string  | ISO 8601 last-updated timestamp          |

## Key Concepts

### Secret References (`{{secret:...}}`)

Any string field that supports secret references can embed a token of the form:

```
{{secret:sec_01HXYZ...}}
```

The token — not the raw value — is what gets stored and echoed back by `GET`/`LIST` endpoints. The server resolves the token to the decrypted value at the point of use only, e.g. right before an outbound HTTP request. The referenced secret must belong to the same project as the resource that uses it; otherwise the API fails fast with `400 SECRET_NOT_FOUND` at create/update time.

Currently supported fields:

| Resource | Field | Resolved when |
| --- | --- | --- |
| [Tool](./tools.md) (`http`) | `execute.url`, `execute.headers` values | The tool is called |
| [Tool](./tools.md) (`mcp`) | `mcp.url`, `mcp.headers` values | The MCP server is contacted (tool listing and calls) |

```json
{
  "execute": {
    "url": "https://api.example.com/convert",
    "headers": { "Authorization": "Bearer {{secret:sec_01HXYZ}}" }
  }
}
```

To rotate a credential, update the secret's value — every tool referencing it picks up the new value on its next call.

For referencing a secret created in the same [Formation](./formations.md) template, see [Sub Expressions](./formations.md#sub-expressions).

### Deletion

By default, deleting a secret that is still referenced by one or more AI providers returns `409 Conflict`. Pass `?force=true` to cascade-delete the dependent AI providers along with the secret.

## Configuration

| Environment Variable     | Required | Description                                                                                      |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `SECRETS_ENCRYPTION_KEY` | Yes      | 64-character hex string (32 bytes). Used for AES-256-GCM encryption of all stored secret values. |

Generate a key with:

```bash
openssl rand -hex 32
```

## Examples

### Create a secret

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-secret --project-id proj_ABC --name "OpenAI Key" --value "sk-abc123..."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.secrets.createSecret({
  body: { project_id: 'proj_ABC', name: 'OpenAI Key', value: 'sk-abc123...' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/secrets \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_ABC", "name": "OpenAI Key", "value": "sk-abc123..."}'
```

</TabItem>
</Tabs>

### Update secret value

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-secret --secret-id sec_01 --value sk-abc123...
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.secrets.updateSecret({
  path: { secret_id: 'sec_01' },
  body: { value: 'sk-abc123...' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/secrets/sec_01 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-abc123..."}'
```

</TabItem>
</Tabs>
