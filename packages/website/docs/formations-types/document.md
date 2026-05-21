---
sidebar_label: Document
sidebar_position: 6
---

# Document

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Stores a text document in a project, optionally indexing it for knowledge retrieval.

:::note
Supports **create** and **delete** only. Updates are not applied — to replace content, delete and re-create the resource.
:::

## Syntax

```yaml
type: document
properties:
  content: String
  path: String
  filename: String
  title: String
  metadata: Object
  tags: Object
```

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyDocument
```

## Properties

**`content`**

Document text content

_Required_: Yes
_Type_: String

---

**`path`**

Virtual path for organising the document

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`filename`**

Original filename

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`title`**

Document title

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`metadata`**

Arbitrary metadata key-value pairs

_Required_: No
_Type_: Object
_Nullable_: Yes

---

**`tags`**

Tag key-value pairs for filtering

_Required_: No
_Type_: Object
_Nullable_: Yes

---
