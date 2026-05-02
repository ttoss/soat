import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Secrets

The Secrets module provides encrypted storage for sensitive values such as API keys and credentials. Values are encrypted at rest using AES-256-GCM and are never returned by any API response.

## Overview

Secrets are associated with a project. Once stored, a secret's value can only be replaced — it is never readable again. All operations return a `has_value` boolean to indicate whether an encrypted value is on file.

Secrets can be linked to [AI Providers](./ai-providers.md) to supply credentials at inference time.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Configuration

| Environment Variable     | Required | Description                                                                                      |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `SECRETS_ENCRYPTION_KEY` | Yes      | 64-character hex string (32 bytes). Used for AES-256-GCM encryption of all stored secret values. |

Generate a key with:

```bash
openssl rand -hex 32
```

## Data Model

| Field        | Type    | Description                              |
| ------------ | ------- | ---------------------------------------- |
| `id`         | string  | Public identifier (e.g. `sec_…`)         |
| `project_id` | string  | ID of the owning project                 |
| `name`       | string  | Human-readable label                     |
| `has_value`  | boolean | `true` when an encrypted value is stored |
| `created_at` | string  | ISO 8601 creation timestamp              |
| `updated_at` | string  | ISO 8601 last-updated timestamp          |

## Deletion behaviour

By default, deleting a secret that is still referenced by one or more AI providers returns `409 Conflict`. Pass `?force=true` to cascade-delete the dependent AI providers along with the secret.

## Examples

### Create a secret

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-secret --project-id proj_ABC --name "OpenAI Key"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.secrets.createSecret({
  body: { project_id: 'proj_ABC', name: 'OpenAI Key' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/secrets \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "proj_ABC", "name": "OpenAI Key"}'
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
// SDK
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
