---
sidebar_label: Memory
sidebar_position: 7
---

# Memory

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Creates a named memory store that actors can read from and write to across conversations.

## Syntax

```yaml
type: memory
properties:
  name: String
  description: String
  tags: String[]
```

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyMemory
```

## Properties

**`name`**

Memory display name

_Required_: Yes
_Type_: String

---

**`description`**

What this memory stores

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`tags`**

Tag strings for filtering

_Required_: No
_Type_: Array of String
_Nullable_: Yes

---
