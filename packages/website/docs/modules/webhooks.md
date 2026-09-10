---
description: "HTTP callbacks that deliver signed event notifications when project resources change."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Webhooks

HTTP callbacks that deliver signed event notifications when project resources change.

## Overview

A webhook is project-scoped: a URL plus a list of event patterns. Matching events are dispatched automatically, retried up to three times, recorded as a row before the first HTTP attempt (see [Delivery durability](#delivery-durability)), and signed with HMAC-SHA256.

Webhooks are **outbound**. For the **inbound** direction (an external system activating an orchestration, agent, or tool) see [Triggers](./triggers.md), whose `webhook` starter verifies an incoming HMAC signature the same way.

To start work inside SOAT when an event fires, bind an [`event` trigger](./triggers.md#event-triggers) to the pattern instead of pointing a webhook at your own inbound hook: no public URL, signature, or second retry policy.

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
| `next_attempt_at` | string \| null                     | When the next attempt becomes due; null once the delivery succeeded or exhausted its attempts |
| `response_body`   | string \| null                     | First 1 KB of the response body returned by the receiver, or the reason a delivery was closed without an attempt |
| `created_at`      | string                             | ISO 8601 creation timestamp                |
| `updated_at`      | string                             | ISO 8601 last-updated timestamp            |

## Key Concepts

### Event Patterns

Patterns are dot-separated:

| Pattern         | Matches                           |
| --------------- | --------------------------------- |
| `files.created` | Exactly the `files.created` event |
| `files.*`       | Any event starting with `files.`  |
| `*`             | Every event in the project        |

Every event is listed in the [Webhook Events Reference](../webhook-events.md), generated from the event registry; a name not there never matches. Example: [Chat with an LLM - Step 9 (Create a session webhook subscription)](/docs/tutorials/chat-with-llm#step-9---create-a-session-webhook-subscription).

### Delivery

A matching event is delivered as an HTTP POST with these headers:

| Header                | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| `X-Soat-Event`        | The event type (e.g., `files.created`)                                     |
| `X-Soat-Delivery`     | Unique delivery ID                                                         |
| `X-Soat-Signature-V2` | Timestamped signature, `t=<unix>,v1=<hex>` — see [Signature verification](#secret-and-signature-verification) |
| `X-Soat-Signature`    | **Deprecated.** HMAC-SHA256 hex digest of the bare request body, as `sha256=<hex>` |

Deliveries are retried up to three times; each attempt is recorded in the delivery log. See [Chat with an LLM - Step 11 (Verify delivery)](/docs/tutorials/chat-with-llm#step-11---verify-delivery-and-final-assistant-message). Test locally with [`soat listen`](../cli/usage.md#testing-webhooks-locally).

### Where a webhook may point

`url` must be an absolute `http`/`https` URL without a username or password (a credential in a URL is echoed by every log line naming it); otherwise `400 VALIDATION_FAILED` on create and update.

The address the hostname **resolves to** passes the deployment's egress rule, re-checked on every redirect hop. A URL resolving inside the deployment's own network (loopback, RFC1918, link-local/cloud metadata, CGNAT, IPv6 ULA) is refused unless listed in [`TOOL_EGRESS_ALLOWED_HOSTS`](../self-hosting/configuration.md#outbound-egress).

Such a delivery is closed as `failed` without a retry, `attempts` still `0`, the reason in `response_body`. `response_body` holds at most the first kilobyte of a real endpoint's answer.

### Delivery durability

A delivery row (payload and next due time) is written **before** the first HTTP request; every later attempt is claimed from that row by a background sweep.

- **A restart does not lose a delivery.** A row left `pending` by a killed process is picked up once its lease expires (about a minute).
- **Retries are spaced.** Exponential backoff with jitter (roughly 1s, then 2s); `next_attempt_at` says when the next is due.

After three failed attempts the delivery is marked `failed` and is not retried automatically. Use [redelivery](#redelivery) to send it again.

**Where the guarantee starts.** The row is inserted in a short in-memory step after the producing write commits: the server matches subscriptions and inserts the delivery rows. A database blip there is retried, and a failure outliving the retries is counted and printed to stderr; a process killed inside that sub-second window loses the event, and no redelivery can recover it. Closing the window would require writing the row in the same transaction as the change.

### Redelivery

[`POST /api/v1/webhook-deliveries/{delivery_id}/redeliver`](/docs/api/webhooks/redeliver-webhook-delivery) queues a stored payload to be sent again.

It creates a **new** delivery record, so the failed attempt stays in the history. Returns `202 Accepted` with the new delivery; poll its `status` for the outcome.

### Event Payload

The body is a **snake_case** JSON envelope:

| Field           | Type   | Description                                                       |
| --------------- | ------ | ----------------------------------------------------------------- |
| `event`         | string | Event type, e.g. `files.created`                                  |
| `project_id`    | string | Public ID of the project the event belongs to                     |
| `resource_type` | string | Type of the resource that changed, e.g. `file`                    |
| `resource_id`   | string | Public ID of the resource that changed                            |
| `data`          | object | The resource payload, in the same shape the REST API returns it   |
| `timestamp`     | string | ISO 8601 timestamp of the event                                   |

```json
{
  "event": "files.created",
  "project_id": "proj_a1b2c3d4",
  "resource_type": "file",
  "resource_id": "file_e5f6g7h8",
  "data": {
    "id": "file_e5f6g7h8",
    "project_id": "proj_a1b2c3d4",
    "filename": "report.pdf"
  },
  "timestamp": "2026-01-31T12:00:00.000Z"
}
```

`data` comes from the same mapper as the REST API; no key inside it is rewritten, so no follow-up `GET` is needed.

### Secret and Signature Verification

Each webhook has a secret generated at creation, returned on create and rotation, or via [`GET /api/v1/webhooks/{webhook_id}/secret`](/docs/api/webhooks/get-webhook-secret) (requires `webhooks:GetWebhookSecret`).

It is stored AES-256-GCM encrypted like [secrets](./secrets.md), keyed by `SECRETS_ENCRYPTION_KEY`, and decrypted only to sign deliveries or to answer that route. See [Configuration](/docs/self-hosting/configuration) for the impact of losing the key.

A stored secret that is not valid ciphertext (encrypted under a changed `SECRETS_ENCRYPTION_KEY`) is refused: `GET .../secret` answers `500 SECRET_NOT_DECRYPTABLE`, and a delivery is recorded `failed` with the reason and `attempts: 0` rather than sent unsigned. Rotate the secret or restore the key.

#### Verifying `X-Soat-Signature-V2`

The header carries two comma-separated elements: `t`, the Unix timestamp (in seconds) at which the attempt was signed, and `v1`, the HMAC-SHA256 hex digest of `<t>.<raw body>`.

```
X-Soat-Signature-V2: t=1769865600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

The timestamp bounds replay: reject a `t` outside your tolerance window. Verify **before** trusting the body, with a constant-time compare.

```js
const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;

// `body` must be the raw request body, exactly as received — parsing and
// re-serializing it changes the bytes and the digest will not match.
const isValid = (secret, body, header) => {
  const elements = Object.fromEntries(
    header.split(',').map((part) => part.split('='))
  );
  const { t, v1 } = elements;
  if (!t || !v1) return false;

  // Reject anything too old (a replay) or too far in the future (a skewed clock).
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex');

  const received = Buffer.from(v1, 'hex');
  const computed = Buffer.from(expected, 'hex');
  if (received.length !== computed.length) return false;
  return crypto.timingSafeEqual(computed, received);
};
```

Each attempt is signed when sent, so a retry carries a fresh timestamp.

#### The deprecated `X-Soat-Signature`

`X-Soat-Signature: sha256=<hex>` signs the bare body with no timestamp, so it cannot bound a replay. It is still sent during the deprecation window; migrate to `X-Soat-Signature-V2`.

```js
// Deprecated — no replay bound.
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
const isValid = `sha256=${expected}` === header;
```

### Policy Gating

Attach a [policy](./policies.md) (a global resource) to filter deliveries without changing subscriptions: the event is delivered only if the policy evaluates to _allow_ for the event context.

### Formation Support

A [Formation](./formations.md) can create webhooks; capture the secret as an output with `ref_attr`:

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

### Redeliver a failed delivery

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat redeliver-webhook-delivery --delivery-id wh_deliv_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.webhooks.redeliverWebhookDelivery({
  path: { delivery_id: 'wh_deliv_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
// data is a new pending delivery — poll it to see the outcome
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/webhook-deliveries/wh_deliv_ABC/redeliver \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
