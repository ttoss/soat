---
sidebar_label: Ai Provider
sidebar_position: 2
---

# Ai Provider

> This page is auto-generated from the formations OpenAPI spec.
> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.

Configures an LLM provider connection (API key, model, endpoint) that agents use to generate responses.

## Syntax

```yaml
type: ai_provider
properties:
  name: String
  provider: String
  default_model: String
  secret_id: String
  base_url: String
  config: Object
```

## Output

The physical resource ID is the **public ID** of the created resource. Reference it from other resources with a `ref` expression:

```yaml
      some_field:
        ref: MyAiProvider
```

## Properties

**`name`**

Provider display name

_Required_: Yes
_Type_: String

---

**`provider`**

Provider type (e.g. openai, anthropic)

_Required_: Yes
_Type_: String

---

**`default_model`**

Default model identifier (e.g. gpt-4o, claude-3-7-sonnet)

_Required_: Yes
_Type_: String

---

**`secret_id`**

Public ID of the secret containing the API key

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`base_url`**

Custom base URL for the provider API (self-hosted or proxy)

_Required_: No
_Type_: String
_Nullable_: Yes

---

**`config`**

Provider-specific extra configuration

_Required_: No
_Type_: Object
_Nullable_: Yes

---
