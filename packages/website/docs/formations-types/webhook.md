---
sidebar_label: Webhook
sidebar_position: 9
---

# Webhook

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Registers an HTTPS endpoint to receive SOAT platform event notifications.

## Syntax

```yaml
type: webhook
properties:
  name: String
  description: String
  url: String
  events: String[]
```

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyWebhook
```

## Properties

**`name`**

Webhook display name

_Required_: Yes
_Type_: String

---

**`description`**

Optional description

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`url`**

HTTPS endpoint that receives event payloads

_Required_: Yes
_Type_: String

---

**`events`**

Event types to subscribe to (e.g. memory.updated)

_Required_: Yes
_Type_: Array of String

---
