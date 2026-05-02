import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Webhooks

The Webhooks module lets you subscribe to events that occur within a project and receive HTTP POST callbacks when those events fire. Every delivery is signed with HMAC-SHA256 so you can verify authenticity on the receiving end.

## Overview

A webhook is scoped to a project. When you create a webhook you specify a URL, a list of event patterns to subscribe to, and optionally a project policy that gates delivery. The server automatically dispatches matching events, retrying up to three times for failed deliveries.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Key Concepts

### Event Patterns

Each webhook subscribes to one or more event patterns. Patterns use a dot-separated hierarchy:

| Pattern        | Matches                          |
| -------------- | -------------------------------- |
| `file.created` | Exactly the `file.created` event |
| `file.*`       | Any event starting with `file.`  |
| `*`            | Every event in the project       |

### Delivery

When an event matches a webhook, the server sends an HTTP POST to the webhook URL with a JSON payload containing the event data. The request includes three headers:

| Header             | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `X-Soat-Event`     | The event type (e.g., `file.created`)                                      |
| `X-Soat-Delivery`  | Unique delivery ID                                                         |
| `X-Soat-Signature` | HMAC-SHA256 hex digest of the request body, signed with the webhook secret |

Deliveries are retried up to three times. Each attempt and its outcome are recorded in a delivery log that you can query through the API.

### Secret and Signature Verification

Every webhook has a secret generated at creation time. To verify a delivery, compute the HMAC-SHA256 of the raw request body using the secret and compare it to the `X-Soat-Signature` header:

```js
const crypto = require('crypto');

const isValid = (secret, body, signature) => {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};
```

### Policy Gating

You can optionally attach a project policy to a webhook. When a policy is set, the event is only delivered if the policy evaluates to _allow_ for the event context. This lets you filter deliveries without changing your event subscriptions.

## Data Model

### Webhook

| Field         | Type           | Description                                 |
| ------------- | -------------- | ------------------------------------------- |
| `id`          | string         | Public identifier                           |
| `project_id`  | string         | ID of the owning project                    |
| `policy_id`   | string \| null | Optional project policy that gates delivery |
| `name`        | string         | Human-readable name                         |
| `description` | string \| null | Optional description                        |
| `url`         | string         | HTTPS endpoint that receives deliveries     |
| `events`      | string[]       | List of event patterns to subscribe to      |
| `active`      | boolean        | Whether the webhook is enabled              |
| `secret`      | string         | Returned only on create and secret rotation |
| `created_at`  | string         | ISO 8601 creation timestamp                 |
| `updated_at`  | string         | ISO 8601 last-updated timestamp             |

### Webhook Delivery

| Field             | Type                               | Description                                |
| ----------------- | ---------------------------------- | ------------------------------------------ |
| `id`              | string                             | Public identifier                          |
| `event_type`      | string                             | The event type that triggered the delivery |
| `payload`         | object                             | The event payload that was sent            |
| `status`          | `pending` \| `success` \| `failed` | Delivery outcome                           |
| `status_code`     | number \| null                     | HTTP response status code                  |
| `attempts`        | number                             | Number of delivery attempts made           |
| `last_attempt_at` | string \| null                     | Timestamp of the most recent attempt       |
| `response_body`   | string \| null                     | Truncated response body from the receiver  |
| `created_at`      | string                             | ISO 8601 creation timestamp                |
| `updated_at`      | string                             | ISO 8601 last-updated timestamp            |

## Examples

### Create a webhook

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-webhook \
  --project-id proj_ABC \
  --name "My Webhook" \
  --url https://example.com/hook \
  --events "sessions.*"
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

const { data, error } = await soat.webhooks.createWebhook({
  path: { project_id: 'proj_ABC' },
  body: {
    name: 'My Webhook',
    url: 'https://example.com/hook',
    events: ['sessions.*'],
  },
});
if (error) throw new Error(JSON.stringify(error));
// data.secret is returned only at creation — store it securely
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/projects/proj_ABC/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Webhook",
    "url": "https://example.com/hook",
    "events": ["sessions.*"]
  }'
```

</TabItem>
</Tabs>
