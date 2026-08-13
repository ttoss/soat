---
description: "Register and manage LLM provider configurations — model, base URL, and API-key secret — per project in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# AI Providers

The AI Providers module lets you register and manage LLM provider configurations for a project. Each provider record stores the model slug, optional base URL, optional configuration, and an optional link to a [Secret](./secrets.md) that supplies the API key.

## Overview

An AI provider is a named configuration that tells the system how to reach a specific LLM endpoint. A project can have multiple providers — for example, one for GPT-4o and another for Claude 3.5.

When a provider is linked to a secret the secret's encrypted value is retrieved and passed as the API key when calling the LLM. The key is never exposed through the API. See it end to end in [Connect Third-Party LLMs - Step 4 (Create provider records)](/docs/tutorials/connect-third-party-llms#step-4--create-provider-records).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider)
- [Connect Third-Party LLMs - Step 4 (Create provider records)](/docs/tutorials/connect-third-party-llms#step-4--create-provider-records)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 3 (Create an AI provider)](/docs/tutorials/multi-agent-orchestration#step-3--create-an-ai-provider)

## Data Model

| Field           | Type             | Description                                               |
| --------------- | ---------------- | --------------------------------------------------------- |
| `id`            | string           | Public identifier (e.g. `aip_…`)                          |
| `project_id`    | string           | ID of the owning project                                  |
| `secret_id`     | string \| null   | Public ID of the linked secret, or `null`                 |
| `name`          | string           | Human-readable label                                      |
| `provider`      | `AiProviderSlug` | Provider slug (see below)                                 |
| `default_model` | string           | Default model name sent to the provider API               |
| `base_url`      | string \| null   | Override base URL (optional, useful for self-hosted LLMs) |
| `config`        | object \| null   | Arbitrary provider-specific configuration object          |
| `created_at`    | string           | ISO 8601 creation timestamp                               |
| `updated_at`    | string           | ISO 8601 last-updated timestamp                           |

### Provider Slugs

Valid values for the `provider` field:

| Slug        | Description                |
| ----------- | -------------------------- |
| `openai`    | OpenAI                     |
| `anthropic` | Anthropic                  |
| `google`    | Google Gemini              |
| `xai`       | xAI (Grok)                 |
| `groq`      | Groq                       |
| `ollama`    | Ollama (local)             |
| `azure`     | Azure OpenAI               |
| `bedrock`   | Amazon Bedrock             |
| `vertex`    | Google Vertex AI           |
| `gateway`   | Generic API gateway        |
| `custom`    | Custom / self-hosted model |

A local `ollama` provider needs no linked secret — it uses the server's `OLLAMA_BASE_URL` instead. See it end to end in [Chat with an LLM - Step 3 (Create a local AI provider)](/docs/tutorials/chat-with-llm#step-3--create-a-local-ai-provider).

## Key Concepts

### Bedrock authentication

The `bedrock` provider supports two authentication modes, determined by the shape of the linked secret's JSON value:

**IAM credentials** — pass `accessKeyId`, `secretAccessKey`, and optionally `sessionToken`. The client signs requests with AWS SigV4.

```json
{
  "accessKeyId": "<aws-access-key-id>",
  "secretAccessKey": "<aws-secret-access-key>",
  "sessionToken": "<optional-session-token>"
}
```

**Bedrock API key** — pass `apiKey` only (format `ABSK…`). The client uses Bearer token authentication via `AWS_BEARER_TOKEN_BEDROCK`. This is the [new authentication mechanism introduced for Amazon Bedrock in 2025](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).

```json
{ "apiKey": "ABSK..." }
```

> **Important:** Store the secret value as a **JSON object** (shown above) — this is the canonical form and the only one that supports IAM credentials. As a convenience, a bare `ABSK…` string (with no JSON wrapper) is also accepted: the server tries to parse the value as JSON first, and if that fails but the value starts with `ABSK` it is treated as `{ "apiKey": "<value>" }`. IAM credentials (`accessKeyId` / `secretAccessKey`) must always use the JSON object form.

If neither field is present the default AWS credential chain (environment variables, instance profile, etc.) is used. The `region` field in the provider's `config` object defaults to `us-east-1`.

You can also pass the API key directly in the provider's `config` object as `apiKey` (without linking a secret). This is useful for quick testing but the secret-linked approach is recommended for production.

```json
{ "apiKey": "ABSK..." }
```

### Vertex AI authentication

The `vertex` provider reaches Gemini models through [Google Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/docs), which is a different surface from the `google` provider — `google` calls the Gemini Developer API with a plain API key, while `vertex` calls a Google Cloud project's regional endpoint and bills through that project. Use `vertex` when the models must run under your own GCP project, VPC, and quota.

Like `bedrock`, the authentication mode is determined by the shape of the linked secret's value:

**Service account** — store the JSON key file verbatim as the secret value. The key file already names its project, so no extra configuration is needed:

```json
{
  "type": "service_account",
  "project_id": "my-gcp-project",
  "client_email": "vertex@my-gcp-project.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
}
```

**Express-mode API key** — store the key on its own (no JSON wrapper), or as `{ "apiKey": "AIza..." }`. [Vertex AI in express mode](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview) targets a global, project-less endpoint, so `project` and `location` are ignored for this mode.

**Application Default Credentials** — link no secret at all. The server falls back to [ADC](https://cloud.google.com/docs/authentication/application-default-credentials): `GOOGLE_APPLICATION_CREDENTIALS`, Workload Identity, the GCE/GKE metadata server, or a local `gcloud auth application-default login`. This is the recommended mode when SOAT itself runs on Google Cloud, because no key material is stored anywhere.

#### Federating an AWS identity (SOAT on ECS or EC2)

ADC also covers the case where SOAT runs on **AWS** and reaches Vertex through [workload identity federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds), so no service-account key is stored. Point `GOOGLE_APPLICATION_CREDENTIALS` at the configuration `gcloud iam workload-identity-pools create-cred-config --aws` writes — it holds no secret material — and SOAT exchanges the task's own AWS identity for a Google access token.

SOAT supplies the AWS half of that exchange from the **AWS default credential chain** rather than from the `credential_source` in the file. That matters on ECS: `google-auth-library` reads AWS credentials only from the `AWS_ACCESS_KEY_ID` environment variables or EC2 IMDS, and a task role is delivered on neither — it arrives on the container credentials endpoint named by `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. Left to the stock configuration, a task either finds no credentials or, where IMDS is reachable, authenticates as the **EC2 instance role** instead; a pool provider scoped to the task role then rejects the exchange with `unauthorized_client`.

Requirements:

- `AWS_REGION` (or `AWS_DEFAULT_REGION`) must be set on the server process — it signs the `GetCallerIdentity` call that proves the identity. Without it, generations fail with `AI_PROVIDER_MISCONFIGURED`.
- The pool provider's attribute condition must admit whichever role the credential chain resolves to. On ECS with a task role, that is the task role.

This applies only to the ADC path, and only when the file is an AWS-sourced `external_account` configuration. A linked service-account secret, express mode, a non-AWS external account, and every other ADC source behave exactly as before.

The provider's `config` object accepts two fields:

| Field      | Default       | Description                                                                                               |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `project`  | —             | Google Cloud project ID. Falls back to the `project_id` of a service-account secret. Required otherwise. |
| `location` | `us-central1` | Vertex region serving the model, e.g. `europe-west4` or `global`.                                          |

```json
{ "project": "my-gcp-project", "location": "europe-west4" }
```

`config.project` overrides the key file's `project_id`, which is how one service account can serve models from several projects. When no project can be resolved — no `config.project`, and either no secret or one without `project_id` — creating a generation fails with `AI_PROVIDER_MISCONFIGURED` (`400`) rather than a generic error.

An `apiKey` in `config` is accepted as an express-mode fallback when no secret is linked, the same as for `bedrock`.

### Listing the models a provider can run

`GET /api/v1/ai-providers/{ai_provider_id}/models` asks the provider which models it can run, using that provider record's own credentials and configuration, and returns provider-native ids — the same strings `default_model` and an agent's `model` carry.

Which models are reachable is a property of the **credential**, not of the provider type: a `vertex` provider sees only the publisher models its Google Cloud project and location serve, and a `bedrock` provider only the foundation models enabled in its region. Two providers of the same slug in the same project can legitimately return different lists, which is why the listing hangs off a provider rather than off a slug. Reading it is how a caller avoids pinning a model that fails at generation time with a 404 that reads like an auth failure.

Each entry carries what the provider reports and omits what it does not: `id`, and optionally `display_name`, `vendor`, `input_modalities`, `output_modalities`, `streaming`, `lifecycle` (`active` / `legacy` / `deprecated`) and `inference_types`. A `lifecycle` other than `active` still serves today but should not be pinned by anything new. A Bedrock model whose `inference_types` offers only `inference_profile` must be invoked through a cross-region profile id rather than the bare model id.

Not every provider type can answer:

| Provider | Listing |
|---|---|
| `openai`, `groq`, `xai`, `gateway`, `custom` | `GET {base_url}/models`, so a self-hosted or proxied endpoint works too |
| `anthropic` | `GET /v1/models` |
| `google` | AI Studio's model list |
| `vertex` | the publisher models for the provider's `config.project` and `config.location` |
| `bedrock` | `ListFoundationModels` in the provider's `config.region` |
| `azure`, `ollama` | **unsupported** — Azure lists deployments an operator named, and Ollama lists whatever was pulled onto that host, so neither answers "which models can this provider run" |

Errors: `MODEL_LISTING_UNSUPPORTED` (400) for `azure` and `ollama`; `AI_PROVIDER_MISCONFIGURED` (400) when the record lacks what the listing needs (a Vertex `config.project`, a Bedrock region, a linked API key); `MODEL_LISTING_FAILED` (502) when the provider rejects the request or answers with something other than JSON — its own status and message are carried in the error message. Authorized by `ai-providers:ListAiProviderModels` on the provider's project.

### Price overrides

A project can price its own provider instances without a global admin. A **per-provider price override** is a [price-book](./usage.md#pricebook) row bound to a specific AI provider — an enterprise-negotiated rate or a gateway with markup — that wins over the global default when [usage](./usage.md) cost is computed for that provider. Manage them with:

- `GET /api/v1/ai-providers/{ai_provider_id}/prices` — list this provider's overrides
- `PUT /api/v1/ai-providers/{ai_provider_id}/prices` — upsert them, keyed on `(model, effective_from)`

Both are authorized by the caller's access to the provider's own project (`ai-providers:GetAiProviderPrices` / `ai-providers:ManageAiProviderPrices`), so one project never sees another's negotiated rates — unlike the global price book, which lists defaults only. The `provider` slug is taken from the AI provider itself (an override matches only when its slug equals the provider's), so you supply just the model, rates, and `effective_from`. `effective_from` must be in the future; past prices are immutable, so ship corrections as new future-dated rows. See [Usage - Pricing](./usage.md#pricing) for how the effective price is chosen and frozen onto each meter.

### Deleting a provider

`DELETE /api/v1/ai-providers/{ai_provider_id}` classifies everything that references the provider into two kinds:

| Dependent | Kind | Behavior |
|---|---|---|
| Chats, agents | **Live reference** | Always block with `409`. `force` does **not** override them — delete or repoint each resource first. |
| [Model routes](./model-routes.md) whose targets name the provider | **Live reference** | Always block with `409`. A target references its provider by id inside the route's `targets`, so no foreign key protects it — the guard is explicit. Repoint or delete the route first. |
| Price overrides | **Soft dependent** | Block with `409` unless `force=true`, which **deletes** the overrides (meaningless without the provider). |
| Usage/generation records | **Soft dependent** | Block with `409` unless `force=true`, which **unlinks** them (nulls the provider FK), preserving the row and its as-billed receipt. |

A delete with no dependents (or `force=true` and only soft dependents) returns `204`. On a `409` the response carries `error.code = "AI_PROVIDER_HAS_DEPENDENTS"` and an `error.meta` describing what blocked it:

```json
{
  "error": {
    "code": "AI_PROVIDER_HAS_DEPENDENTS",
    "message": "AI provider 'aip_01' is in use by 2 chat(s), 1 agent(s) ...",
    "meta": {
      "chatCount": 2, "chatIds": ["chat_01", "chat_02"],
      "agentCount": 1, "agentIds": ["agent_01"],
      "modelRouteCount": 0, "modelRouteIds": [],
      "priceOverrideCount": 0, "usageEventCount": 0,
      "forcible": false
    }
  }
}
```

`forcible` is `true` only when the block comes solely from soft dependents — i.e. a `force=true` retry would succeed. The `*Ids` arrays sample up to 20 offending IDs so you can act on them directly; the `*Count` fields always report the true totals.

## Examples

### Create an AI provider

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ai-provider \
  --project-id proj_ABC \
  --name "OpenAI GPT-4o" \
  --provider openai \
  --default-model gpt-4o \
  --secret-id sec_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.aiProviders.createAiProvider({
  body: {
    project_id: 'proj_ABC',
    name: 'OpenAI GPT-4o',
    provider: 'openai',
    default_model: 'gpt-4o',
    secret_id: 'sec_01',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/ai-providers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "OpenAI GPT-4o",
    "provider": "openai",
    "default_model": "gpt-4o",
    "secret_id": "sec_01"
  }'
```

</TabItem>
</Tabs>

### Create a Google Vertex AI provider

Assumes `sec_01` holds a service-account key file. See [Vertex AI authentication](#vertex-ai-authentication) for the other two modes.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ai-provider \
  --project-id proj_ABC \
  --name "Vertex Gemini" \
  --provider vertex \
  --default-model gemini-2.0-flash \
  --secret-id sec_01 \
  --config '{"location":"europe-west4"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.aiProviders.createAiProvider({
  body: {
    project_id: 'proj_ABC',
    name: 'Vertex Gemini',
    provider: 'vertex',
    default_model: 'gemini-2.0-flash',
    secret_id: 'sec_01',
    config: { location: 'europe-west4' },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/ai-providers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Vertex Gemini",
    "provider": "vertex",
    "default_model": "gemini-2.0-flash",
    "secret_id": "sec_01",
    "config": { "location": "europe-west4" }
  }'
```

</TabItem>
</Tabs>

### List providers in a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-ai-providers --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.aiProviders.listAiProviders({
  query: { project_id: 'proj_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/ai-providers?project_id=proj_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Set a per-provider price override

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-ai-provider-prices \
  --ai-provider-id aip_ABC \
  --prices '[{"model":"gpt-4o","input_price_per_m":5,"output_price_per_m":15,"effective_from":"2099-01-01T00:00:00.000Z"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.aiProviders.updateAiProviderPrices({
  path: { ai_provider_id: 'aip_ABC' },
  body: {
    prices: [
      {
        model: 'gpt-4o',
        input_price_per_m: 5,
        output_price_per_m: 15,
        effective_from: '2099-01-01T00:00:00.000Z',
      },
    ],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PUT https://api.example.com/api/v1/ai-providers/aip_ABC/prices \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "prices": [
      {
        "model": "gpt-4o",
        "input_price_per_m": 5,
        "output_price_per_m": 15,
        "effective_from": "2099-01-01T00:00:00.000Z"
      }
    ]
  }'
```

</TabItem>
</Tabs>
