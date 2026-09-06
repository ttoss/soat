---
description: "Generate numeric vector representations of text using SOAT's configured embedding model."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Embeddings

Generate numeric vector representations of text using the server's configured embedding model.

## Overview

The Embeddings module exposes the server's embedding model as a REST endpoint. A single call accepts one or more text strings and returns the corresponding floating-point vectors. These vectors capture semantic meaning and can be used for downstream tasks such as similarity scoring, clustering, classification, or feeding a custom search index.

The embedding model is configured server-side via environment variables (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`). `ollama`, `openai`, and `bedrock` (Amazon Bedrock) are supported backends. Callers do not choose the model at request time; the server always uses the configured model so all vectors in a deployment share the same space.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Configuration

| Environment Variable  | Required | Description                                                                                              |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `EMBEDDING_PROVIDER`  | Yes      | Embedding backend: `ollama`, `openai`, or `bedrock`.                                                     |
| `EMBEDDING_MODEL`     | Yes      | Model identifier for the backend (e.g. `qwen3-embedding:0.6b`, `text-embedding-3-small`, `amazon.titan-embed-text-v2:0`). |
| `EMBEDDING_DIMENSIONS`| Yes      | Vector dimensionality. Must match the model output, e.g. `1024` — the server fails at startup when unset. |
| `OLLAMA_BASE_URL`     | No       | Ollama server URL (`ollama` only). Defaults to `http://localhost:11434`.                                 |
| `EMBEDDING_API_KEY`   | No       | API key for the backend: the OpenAI key (`openai`), or a Bedrock `ABSK…` bearer token (`bedrock`). For `openai`, falls back to `OPENAI_API_KEY`. |
| `EMBEDDING_BASE_URL`  | No       | Override the base URL for any OpenAI-compatible endpoint (`openai` only).                                 |
| `EMBEDDING_REGION`    | No       | AWS region for Bedrock (`bedrock` only). Falls back to `AWS_REGION`, then `us-east-1`.                    |

### Provider selection

- **`ollama`** — local models via the [Ollama](https://ollama.com) client at `OLLAMA_BASE_URL`. No credentials required.
- **`openai`** — the [OpenAI](https://platform.openai.com/docs/guides/embeddings) embeddings API (or any OpenAI-compatible endpoint via `EMBEDDING_BASE_URL`), authenticated with `EMBEDDING_API_KEY`.
- **`bedrock`** — [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html) embedding models. Authenticate with an `ABSK…` bearer token in `EMBEDDING_API_KEY`, or leave it unset to use the standard AWS credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

## Data Model

The endpoint is stateless — it does not store embeddings. The response shape depends on which input fields are provided.

| Field        | Type         | Description                                                              |
| ------------ | ------------ | ------------------------------------------------------------------------ |
| `embedding`  | `number[]`   | Returned when `input` (single string) is provided.                       |
| `embeddings` | `number[][]` | Returned when `inputs` (array of strings) is provided.                   |

Both fields can be present if the request includes both `input` and `inputs`.

The request also accepts an optional `project_id`, which names the project the
call's token usage is billed to — see [Metering](#metering).

## Key Concepts

### Single vs batch

Pass `input` (a string) for a single vector, or `inputs` (an array of strings) for multiple vectors in one request. Batch calls reduce per-request overhead. Both can be combined in one call.

### Shared vector space

All embeddings produced by a given SOAT deployment are in the same vector space because they use the same model. Cosine similarity between any two vectors produced by the same server is meaningful. Vectors from different deployments or models are not comparable.

### Metering

Every embedding call is metered as an `llm_tokens` usage event with `source`
`embedding`, whatever reached the model: this endpoint, document ingestion, a
memory write, an `embedding_similarity` scorer, or the query embedding behind a
knowledge search. Spend therefore appears in
[`GET /api/v1/usage/meters`](/docs/api/usage/list-usage-meters) and counts
towards a project's `cost_usd` and `tokens`
[quotas](./quotas.md), like every other provider call.

A usage event belongs to a project, so an embedding call needs one:

| Call | Billed to |
| --- | --- |
| [`POST /api/v1/embeddings`](/docs/api/embeddings/create-embeddings) with `project_id` | that project — the caller must be able to write to it |
| The same call from a project-scoped credential | the credential's project |
| The same call with neither | nothing — the call is served but not metered |
| Ingestion, memory, evaluation | the document's, memory's or run's project |
| A knowledge search | the project searched, when the search is scoped to exactly one |

### Pricing embeddings

**The provider reports tokens, never money.** `cost_usd` is computed at write
time as `tokens × unit_price`, read from the effective
[price book](./usage.md#pricing) row for
`(provider, model, input_tokens)` — where `provider` is the `EMBEDDING_PROVIDER`
slug, `model` is `EMBEDDING_MODEL` verbatim, and `input_tokens` is the only
dimension an embedding has (the model emits no completion, so there is no output
rate to price against).

**No price rows ship by default.** Until an operator seeds one, an embedding
records its token quantity with `cost_usd` of `null` — a `tokens` quota enforces
immediately, a `cost_usd` quota still sees nothing. This is the same "captured
but not priced" semantics every other meter has: an absent price is reported as
`null` rather than a misleading `0`.

Two of the three price tiers can cover embeddings:

| Tier | Scope | Applies to embeddings? |
| --- | --- | --- |
| Provider instance | One `ai_provider_id` | **No** — the event carries no provider record, so nothing matches |
| Project + slug | One project's rate for a provider slug | Yes — [`PUT /api/v1/projects/{project_id}/prices`](/docs/api/projects/update-project-prices) |
| Global default | Every project | Yes — [`PUT /api/v1/usage/prices`](/docs/api/usage/upsert-price-book) |

The provider-instance tier is unreachable because the embedding stack is
configured per deployment rather than by an AI provider record. That is also why
one global row prices embeddings for every project at once:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat upsert-price-book --prices '[{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "component": "input_tokens",
  "unit": "token",
  "unit_price": 0.00000002,
  "effective_from": "2020-01-01T00:00:00.000Z"
}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { Usage } from '@soat/sdk';

await Usage.upsertPriceBook({
  client,
  body: {
    prices: [
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        component: 'input_tokens',
        unit: 'token',
        unit_price: 0.00000002,
        effective_from: '2020-01-01T00:00:00.000Z',
      },
    ],
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/usage/prices" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prices":[{"provider":"openai","model":"text-embedding-3-small","component":"input_tokens","unit":"token","unit_price":0.00000002,"effective_from":"2020-01-01T00:00:00.000Z"}]}'
```

</TabItem>
</Tabs>

`unit_price` is per token, so a vendor rate quoted per million tokens is that
figure divided by 1,000,000 (`$0.02 / 1M` → `0.00000002`). Seeding the price
book is an admin operation.

**The back-dated `effective_from` above is deliberate, and only a first price may
use one.** A cost is frozen when the usage event is written, so a row that
arrives afterwards cannot reach back: requiring a future timestamp for the very
first price would leave a window in which the model is live and unpriced, and
every embedding landing inside it metered at `null` permanently. Once that
`(provider, model, component)` is priced in this scope or a broader one, the
timestamp must be in the future — a correction is a new row, never an edit, so
recorded spend stays explainable by the rows that produced it.

For the same reason the resolved `unit_price`, `cost_usd` and `price_id` are
frozen onto the usage event at write time: repricing changes what the *next*
embedding costs, never what an earlier one already cost.

### 503 when unconfigured

If `EMBEDDING_PROVIDER` or `EMBEDDING_MODEL` is not set, the server returns `503 EMBEDDING_NOT_CONFIGURED`. This is a configuration error, not a caller error.

## Examples

### Single text

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-embeddings --project-id "proj_V1StGXR8Z5jdHi6B" \
  --input "The quick brown fox jumps over the lazy dog."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { Embeddings, createClient, createConfig } from '@soat/sdk';

const client = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047',
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
);

const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    input: 'The quick brown fox jumps over the lazy dog.',
  },
});

console.log(data.embedding.length); // 1024 (depends on EMBEDDING_DIMENSIONS)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_V1StGXR8Z5jdHi6B","input":"The quick brown fox jumps over the lazy dog."}' \
  | jq '.embedding | length'
```

</TabItem>
</Tabs>

### Batch of texts

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-embeddings --inputs '["First sentence.", "Second sentence.", "Third sentence."]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    inputs: ['First sentence.', 'Second sentence.', 'Third sentence.'],
  },
});

console.log(data.embeddings.length); // 3
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["First sentence.","Second sentence.","Third sentence."]}' \
  | jq '.embeddings | length'
```

</TabItem>
</Tabs>
