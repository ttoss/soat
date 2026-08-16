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

> **Important:** Store the secret value as a **JSON object** (shown above) — the only form that supports IAM credentials. As a convenience, a bare `ABSK…` string is also accepted and treated as `{ "apiKey": "<value>" }`.

If neither field is present the default AWS credential chain (environment variables, instance profile, etc.) is used. The `region` field in the provider's `config` object defaults to `us-east-1`. An `apiKey` in `config` (without a linked secret) also works — useful for quick testing; link a secret in production.

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

ADC also covers SOAT running on **AWS** reaching Vertex through [workload identity federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds): point `GOOGLE_APPLICATION_CREDENTIALS` at the configuration `gcloud iam workload-identity-pools create-cred-config --aws` writes (it holds no secret material) and SOAT exchanges the task's own AWS identity for a Google access token. SOAT supplies the AWS half from the **AWS default credential chain** rather than the file's `credential_source`, so an ECS task role (delivered on the container credentials endpoint, which `google-auth-library` cannot read) works and is not silently replaced by the EC2 instance role.

Requirements: `AWS_REGION` (or `AWS_DEFAULT_REGION`) must be set on the server process — without it, generations fail with `AI_PROVIDER_MISCONFIGURED` — and the pool provider's attribute condition must admit whichever role the credential chain resolves to (on ECS, the task role). This applies only to the ADC path with an AWS-sourced `external_account` configuration; every other mode behaves as before.

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

[`GET /api/v1/ai-providers/{ai_provider_id}/models`](/docs/api/ai-providers/list-ai-provider-models) asks the provider which models it can run, using that provider record's own configuration and credentials, and returns provider-native ids — the same strings `default_model` and an agent's `model` carry. Which models are reachable is a property of the **credential**, not of the slug (two providers of the same slug can return different lists), which is why the listing hangs off a provider.

Each entry carries what the provider reports: `id`, and optionally `display_name`, `vendor`, `input_modalities`, `output_modalities`, `streaming`, `lifecycle` (`active` / `legacy` / `deprecated`) and `inference_types`. A `lifecycle` other than `active` still serves but should not be pinned by anything new. A Bedrock model whose `inference_types` offers only `inference_profile` must be invoked through a cross-region profile id.

Not every provider type can answer:

| Provider | Listing | Credential the listing uses |
|---|---|---|
| `openai`, `groq`, `xai`, `gateway`, `custom` | `GET {base_url}/models`, so a self-hosted or proxied endpoint works too | the linked secret — **required** |
| `anthropic` | `GET /v1/models` | the linked secret — **required** |
| `google` | AI Studio's model list | the linked secret — **required** |
| `vertex` | the publisher models for the provider's project and `config.location` | the linked service-account key, else [ADC](https://cloud.google.com/docs/authentication/application-default-credentials) |
| `bedrock` | `ListFoundationModels` in the provider's `config.region` | the linked secret's IAM keys or API key, else the AWS default credential chain |
| `azure`, `ollama` | **unsupported** — Azure lists deployments an operator named, and Ollama lists whatever was pulled onto that host, so neither answers "which models can this provider run" | — |

Listing resolves credentials exactly the way generation does, so a record that can generate can list. For `bedrock` and `vertex` that means the linked secret wins when present and the server's ambient credentials are the fallback, not the other way round — a record whose IAM keys or service-account key are correct no longer depends on the server holding credentials of its own.

Two consequences worth knowing:

- **A Vertex record needs no `config.project` when its secret is a service-account key**, because the key file names its own project. `config.project` still overrides it.
- **Vertex express mode cannot list.** An API-key (express-mode) Vertex record talks to a global, project-less endpoint, but the publisher-model catalogue is per-project, so there is no URL to call. Listing returns `MODEL_LISTING_UNSUPPORTED` naming the reason rather than guessing a project.

Errors: `MODEL_LISTING_UNSUPPORTED` (400) for `azure`, `ollama`, and Vertex express mode; `AI_PROVIDER_MISCONFIGURED` (400) when the record lacks what the listing needs (a Vertex project from either `config.project` or the key file, a Bedrock region, or — for the API-key providers above — a linked secret); `MODEL_LISTING_FAILED` (502) when the provider rejects the request or answers with something other than JSON — its own status and message are carried in the error message. Authorized by `ai-providers:ListAiProviderModels` on the provider's project.

#### Listing models before you hold credentials

Because `secret_id` is optional on create and `bedrock` / `vertex` fall back to the server's ambient credentials, a provider record with **no linked secret** can still list models. Browsing a vendor's live catalogue before any key is provisioned therefore needs no separate endpoint — create a credential-less record naming only the region (or GCP project) and list against it:

```bash
soat create-ai-provider \
  --project-id proj_ABC \
  --name "Bedrock Catalog" \
  --provider bedrock \
  --default-model anthropic.claude-3-5-sonnet-20241022-v2:0 \
  --config '{"region":"us-east-1"}'

soat list-ai-provider-models --ai-provider-id aip_01
```

The record supplies the region and the IAM scope; the credential comes from the server's instance role. This is the supported way to keep a model catalogue current instead of vendoring a static list that drifts whenever the vendor ships a model.

### Price overrides

A project can price its own provider instances without a global admin. A **per-provider price override** is a [price-book](./usage.md#pricebook) row bound to a specific AI provider — an enterprise-negotiated rate or a gateway with markup — that wins over the global default when [usage](./usage.md) cost is computed for that provider. Manage them with:

- [`GET /api/v1/ai-providers/{ai_provider_id}/prices`](/docs/api/ai-providers/get-ai-provider-prices) — list this provider's overrides
- [`PUT /api/v1/ai-providers/{ai_provider_id}/prices`](/docs/api/ai-providers/update-ai-provider-prices) — upsert them, keyed on `(model, effective_from)`

Both are authorized by the caller's access to the provider's own project (`ai-providers:GetAiProviderPrices` / `ai-providers:ManageAiProviderPrices`), so one project never sees another's negotiated rates. The `provider` slug is taken from the AI provider itself — you supply just the model, rates, and `effective_from`, which must be in the future (past prices are immutable; ship corrections as new future-dated rows). See [Usage - Pricing](./usage.md#pricing) for how the effective price is chosen and frozen onto each meter.

### Deleting a provider

[`DELETE /api/v1/ai-providers/{ai_provider_id}`](/docs/api/ai-providers/delete-ai-provider) classifies everything that references the provider into two kinds:

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
