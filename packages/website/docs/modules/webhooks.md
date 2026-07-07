import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Webhooks

HTTP callbacks that deliver signed event notifications when project resources change.

## Overview

A webhook is scoped to a project. When you create a webhook you specify a URL and a list of event patterns to subscribe to. The server dispatches matching events automatically, retrying up to three times for failed deliveries. Every delivery is signed with HMAC-SHA256 so receivers can verify authenticity.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 8 (Start a local webhook listener)](/docs/tutorials/chat-with-llm#step-8---start-a-local-webhook-listener)
- [Chat with an LLM - Step 9 (Create a session webhook subscription)](/docs/tutorials/chat-with-llm#step-9---create-a-session-webhook-subscription)
- [Chat with an LLM - Step 11 (Verify delivery)](/docs/tutorials/chat-with-llm#step-11---verify-delivery-and-final-assistant-message)

## Data Model

### Webhook

| Field         | Type           | Description                                 |
| ------------- | -------------- | ------------------------------------------- |
| `id`          | string         | Public identifier                           |
| `project_id`  | string         | ID of the owning project                    |
| `policy_id`   | string \| null | Optional [policy](./policies.md) that gates delivery |
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
| `webhook_id`      | string                             | Public ID of the webhook this delivery belongs to |
| `event_type`      | string                             | The event type that triggered the delivery |
| `payload`         | object                             | The event payload that was sent            |
| `status`          | `pending` \| `success` \| `failed` | Delivery outcome                           |
| `status_code`     | number \| null                     | HTTP response status code                  |
| `attempts`        | number                             | Number of delivery attempts made           |
| `last_attempt_at` | string \| null                     | Timestamp of the most recent attempt       |
| `response_body`   | string \| null                     | Response body returned by the receiver      |
| `created_at`      | string                             | ISO 8601 creation timestamp                |
| `updated_at`      | string                             | ISO 8601 last-updated timestamp            |

## Key Concepts

### Event Patterns

Each webhook subscribes to one or more event patterns using dot-separated hierarchy:

| Pattern        | Matches                          |
| -------------- | -------------------------------- |
| `file.created` | Exactly the `file.created` event |
| `file.*`       | Any event starting with `file.`  |
| `*`            | Every event in the project       |

See it end to end in [Chat with an LLM - Step 9 (Create a session webhook subscription)](/docs/tutorials/chat-with-llm#step-9---create-a-session-webhook-subscription).

### Delivery

When an event matches a webhook, the server sends an HTTP POST to the webhook URL. The request includes three headers:

| Header             | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `X-Soat-Event`     | The event type (e.g., `file.created`)                                      |
| `X-Soat-Delivery`  | Unique delivery ID                                                         |
| `X-Soat-Signature` | HMAC-SHA256 hex digest of the request body, signed with the webhook secret |

Deliveries are retried up to three times. Each attempt and its outcome are recorded in a delivery log queryable through the API. To watch a real delivery arrive and inspect its outcome, see [Chat with an LLM - Step 11 (Verify delivery)](/docs/tutorials/chat-with-llm#step-11---verify-delivery-and-final-assistant-message).

### Secret and Signature Verification

Every webhook has a secret generated at creation time. The secret is returned in the response body on create or secret rotation. You can also retrieve it explicitly via `GET /api/v1/webhooks/{webhook_id}/secret` (requires `webhooks:GetWebhookSecret`).

To verify a delivery:

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

Attach a [policy](./policies.md) to a webhook to filter deliveries without changing your event subscriptions. Policies are global resources (not scoped to any project); when one is set on a webhook, the event is only delivered if the policy evaluates to _allow_ for the event context.

### Formation Support

Webhooks can be created as part of a [Formation](./formations.md). The webhook secret can be captured as a formation output using a `ref_attr` expression:

```json
{
  "resources": {
    "MyWebhook": {
      "type": "webhook",
      "properties": {
        "name": "my-hook",
        "url": "https://example.com/hook",
        "events": ["*"]
      }
    }
  },
  "outputs": {
    "webhookId": { "ref": "MyWebhook" },
    "webhookSecret": { "ref_attr": "MyWebhook.secret" }
  }
}
```

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
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.webhooks.createWebhook({
  body: {
    project_id: 'proj_ABC',
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
curl -X POST https://api.example.com/api/v1/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "My Webhook",
    "url": "https://example.com/hook",
    "events": ["sessions.*"]
  }'
```

</TabItem>
</Tabs>

### List webhooks

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-webhooks --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.webhooks.listWebhooks({
  query: { project_id: 'proj_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/webhooks?project_id=proj_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
