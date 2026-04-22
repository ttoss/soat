---
sidebar_position: 12
---

# Webhooks

The Webhooks module lets you subscribe to events that occur within a project and receive HTTP POST callbacks when those events fire. Every delivery is signed with HMAC-SHA256 so you can verify authenticity on the receiving end.

## Overview

A webhook is scoped to a project. When you create a webhook you specify a URL, a list of event patterns to subscribe to, and optionally a project policy that gates delivery. The server automatically dispatches matching events, retrying up to three times for failed deliveries.

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
| `projectId`   | string         | ID of the owning project                    |
| `policyId`    | string \| null | Optional project policy that gates delivery |
| `name`        | string         | Human-readable name                         |
| `description` | string \| null | Optional description                        |
| `url`         | string         | HTTPS endpoint that receives deliveries     |
| `events`      | string[]       | List of event patterns to subscribe to      |
| `active`      | boolean        | Whether the webhook is enabled              |
| `secret`      | string         | Returned only on create and secret rotation |
| `createdAt`   | string         | ISO 8601 creation timestamp                 |
| `updatedAt`   | string         | ISO 8601 last-updated timestamp             |

### Webhook Delivery

| Field           | Type                               | Description                                |
| --------------- | ---------------------------------- | ------------------------------------------ |
| `id`            | string                             | Public identifier                          |
| `eventType`     | string                             | The event type that triggered the delivery |
| `payload`       | object                             | The event payload that was sent            |
| `status`        | `pending` \| `success` \| `failed` | Delivery outcome                           |
| `statusCode`    | number \| null                     | HTTP response status code                  |
| `attempts`      | number                             | Number of delivery attempts made           |
| `lastAttemptAt` | string \| null                     | Timestamp of the most recent attempt       |
| `responseBody`  | string \| null                     | Truncated response body from the receiver  |
| `createdAt`     | string                             | ISO 8601 creation timestamp                |
| `updatedAt`     | string                             | ISO 8601 last-updated timestamp            |

## Permissions

Webhook operations are governed by per-project policies. Grant the following permissions to allow a user to perform each action:

| Action           | Permission                       | REST Endpoint                                                         | MCP Tool                  |
| ---------------- | -------------------------------- | --------------------------------------------------------------------- | ------------------------- |
| List webhooks    | `webhooks:ListWebhooks`          | `GET /api/v1/projects/:projectId/webhooks`                            | `list-webhooks`           |
| Create a webhook | `webhooks:CreateWebhook`         | `POST /api/v1/projects/:projectId/webhooks`                           | `create-webhook`          |
| Get a webhook    | `webhooks:GetWebhook`            | `GET /api/v1/projects/:projectId/webhooks/:id`                        | `get-webhook`             |
| Update a webhook | `webhooks:UpdateWebhook`         | `PUT /api/v1/projects/:projectId/webhooks/:id`                        | `update-webhook`          |
| Delete a webhook | `webhooks:DeleteWebhook`         | `DELETE /api/v1/projects/:projectId/webhooks/:id`                     | `delete-webhook`          |
| Rotate secret    | `webhooks:RotateWebhookSecret`   | `POST /api/v1/projects/:projectId/webhooks/:id/rotate-secret`         | `rotate-webhook-secret`   |
| List deliveries  | `webhooks:ListWebhookDeliveries` | `GET /api/v1/projects/:projectId/webhooks/:id/deliveries`             | `list-webhook-deliveries` |
| Get a delivery   | `webhooks:GetWebhookDelivery`    | `GET /api/v1/projects/:projectId/webhooks/:id/deliveries/:deliveryId` | `get-webhook-delivery`    |
