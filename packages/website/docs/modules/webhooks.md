---
description: "HTTP callbacks that deliver signed event notifications when project resources change."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Webhooks

HTTP callbacks that deliver signed event notifications when project resources change.

## Overview

A webhook is scoped to a project. When you create a webhook you specify a URL and a list of event patterns to subscribe to. The server dispatches matching events automatically, retrying up to three times for failed deliveries. Every delivery is recorded as a row before the first HTTP attempt and retried from that row, so a restart mid-delivery does not lose it — see [Delivery durability](#delivery-durability). Every delivery is signed with HMAC-SHA256 so receivers can verify authenticity.

Webhooks are **outbound** — SOAT calls your endpoint when events occur. For the **inbound** direction — an external system calling SOAT to activate an orchestration, agent, or tool — see [Triggers](./triggers.md), whose `webhook` starter verifies an incoming HMAC signature the same way.

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
| `response_body`   | string \| null                     | Response body returned by the receiver      |
| `created_at`      | string                             | ISO 8601 creation timestamp                |
| `updated_at`      | string                             | ISO 8601 last-updated timestamp            |

## Key Concepts

### Event Patterns

Each webhook subscribes to one or more event patterns using dot-separated hierarchy:

| Pattern         | Matches                           |
| --------------- | --------------------------------- |
| `files.created` | Exactly the `files.created` event |
| `files.*`       | Any event starting with `files.`  |
| `*`             | Every event in the project        |

Every event SOAT emits is listed in the [Webhook Events Reference](../webhook-events.md), which is generated from the server's event registry — a name that is not there is one no subscription will ever match.

See it end to end in [Chat with an LLM - Step 9 (Create a session webhook subscription)](/docs/tutorials/chat-with-llm#step-9---create-a-session-webhook-subscription).

### Delivery

When an event matches a webhook, the server sends an HTTP POST to the webhook URL. The request includes these headers:

| Header                | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| `X-Soat-Event`        | The event type (e.g., `files.created`)                                     |
| `X-Soat-Delivery`     | Unique delivery ID                                                         |
| `X-Soat-Signature-V2` | Timestamped signature, `t=<unix>,v1=<hex>` — see [Signature verification](#secret-and-signature-verification) |
| `X-Soat-Signature`    | **Deprecated.** HMAC-SHA256 hex digest of the bare request body, as `sha256=<hex>` |

Deliveries are retried up to three times. Each attempt and its outcome are recorded in a delivery log queryable through the API. To watch a real delivery arrive and inspect its outcome, see [Chat with an LLM - Step 11 (Verify delivery)](/docs/tutorials/chat-with-llm#step-11---verify-delivery-and-final-assistant-message).

Before pointing `url` at a real endpoint, use [`soat listen`](../cli/usage.md#testing-webhooks-locally) to receive and inspect deliveries on your local machine.

### Delivery durability

A delivery is a database row, not an in-flight function call. The row is written — with its payload and the time its next attempt is due — **before** the first HTTP request is made, and every attempt after the first is claimed from that row by a background sweep.

Two consequences matter to a subscriber:

- **A restart does not lose a delivery.** If the server is killed between attempts, or during one, the row keeps its `pending` status and is picked up again once the crashed process's lease expires (about a minute). Nothing depends on the process that emitted the event still being alive.
- **Retries are spaced, not immediate.** A failed attempt schedules the next one behind an exponential backoff with jitter (roughly 1s, then 2s), rather than firing three times back to back. `next_attempt_at` on the delivery tells you when the next one is due.

After three failed attempts the delivery is marked `failed` and is not retried automatically. Use [redelivery](#redelivery) to send it again.

### Redelivery

`POST /api/v1/webhook-deliveries/{delivery_id}/redeliver` queues a stored payload to be sent again — useful when your endpoint was down, or when you have fixed a bug and want the original event back.

It creates a **new** delivery record rather than resetting the original, so the failed attempt stays in the history. The call returns `202 Accepted` with the new delivery; the send itself happens in the background, so poll that delivery's `status` to observe the outcome.

### Event Payload

The request body is a JSON envelope wrapping the resource payload. Like every other SOAT surface, it is **snake_case**:

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

`data` is carried through verbatim from the same mapper the REST API uses, so a subscriber never needs a follow-up `GET` to read the resource, and no key inside it is rewritten.

### Secret and Signature Verification

Every webhook has a secret generated at creation time. The secret is returned in the response body on create or secret rotation. You can also retrieve it explicitly via [`GET /api/v1/webhooks/{webhook_id}/secret`](/docs/api/webhooks/get-webhook-secret) (requires `webhooks:GetWebhookSecret`).

The secret is stored encrypted at rest using the same AES-256-GCM encryption as [secrets](./secrets.md), keyed by `SECRETS_ENCRYPTION_KEY`. It is decrypted only to sign outbound deliveries or to return it through the API to a caller with `webhooks:GetWebhookSecret`. See [Configuration](/docs/self-hosting/configuration) for the operational impact of losing this key.

A stored secret that is **not** valid ciphertext — one written before secret-at-rest encryption, or encrypted under a `SECRETS_ENCRYPTION_KEY` that has since changed — is refused rather than guessed at. `GET .../secret` answers `500 SECRET_NOT_DECRYPTABLE`, and an outbound delivery is recorded as `failed` with the reason and `attempts: 0` rather than being sent unsigned. Rotate the secret to replace it, or restore the original key.

#### Verifying `X-Soat-Signature-V2`

The header carries two comma-separated elements: `t`, the Unix timestamp (in seconds) at which the attempt was signed, and `v1`, the HMAC-SHA256 hex digest of `<t>.<raw body>`.

```
X-Soat-Signature-V2: t=1769865600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

Signing the timestamp along with the body is what bounds a replay: an attacker who captures a delivery cannot resend it later, because you reject a timestamp outside your tolerance window. Verify the digest **before** trusting anything in the body, and compare with a constant-time function.

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

Each attempt is signed at the moment it is sent, so a retry carries its own fresh timestamp and passes the same tolerance check as a first attempt.

#### The deprecated `X-Soat-Signature`

`X-Soat-Signature: sha256=<hex>` signs the bare body with no timestamp, so it cannot distinguish a live delivery from one replayed days later. It is still sent alongside the new header during the deprecation window so existing subscribers keep working. Migrate to `X-Soat-Signature-V2` and stop reading the old header.

```js
// Deprecated — no replay bound.
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
const isValid = `sha256=${expected}` === header;
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
