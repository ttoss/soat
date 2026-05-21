---
sidebar_label: Actor
sidebar_position: 5
---

# Actor

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Creates a stateful conversation actor that wraps an agent or chat session and optionally links to a memory store.

## Syntax

```yaml
type: actor
properties:
  name: String
  external_id: String
  instructions: String
  agent_id: String
  chat_id: String
  memory_id: String
  auto_create_memory: Boolean
```

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyActor
```

## Properties

**`name`**

Actor display name

_Required_: Yes
_Type_: String

---

**`external_id`**

External identifier for idempotent actor creation

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`instructions`**

Persona-specific instructions

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`agent_id`**

Linked agent ID (mutually exclusive with chat_id)

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`chat_id`**

Linked chat ID (mutually exclusive with agent_id)

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`memory_id`**

Linked memory ID

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`auto_create_memory`**

Whether to auto-create memory when actor is created

_Required_: No
_Type_: Boolean

---
