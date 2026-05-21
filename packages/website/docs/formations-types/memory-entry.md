---
sidebar_label: Memory Entry
sidebar_position: 8
---

# Memory Entry

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Adds a single text entry to a memory store.

## Syntax

```yaml
type: memory_entry
properties:
  memory_id: String
  content: String
  source: String
```

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyMemoryEntry
```

## Properties

**`memory_id`**

Public ID of the parent memory (or ref expression)

_Required_: Yes
_Type_: String

---

**`content`**

Text content of the memory entry

_Required_: Yes
_Type_: String

---

**`source`**

Origin label (e.g. manual, document, import)

_Required_: No
_Type_: String
_Nullable_: Yes

---
