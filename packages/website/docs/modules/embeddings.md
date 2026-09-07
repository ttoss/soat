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
| `EMBEDDING_DIMENSIONS`| Yes      | Vector dimensionality. Must match the model output, e.g. `1024` — the server fails at startup when unset, or above `2000`, the widest vector pgvector can index. |
| `OLLAMA_BASE_URL`     | No       | Ollama server URL (`ollama` only). Defaults to `http://localhost:11434`.                                 |
| `EMBEDDING_API_KEY`   | No       | API key for the backend: the OpenAI key (`openai`), or a Bedrock `ABSK…` bearer token (`bedrock`). For `openai`, falls back to `OPENAI_API_KEY`. |
| `EMBEDDING_BASE_URL`  | No       | Override the base URL for any OpenAI-compatible endpoint (`openai` only).                                 |
| `EMBEDDING_REGION`    | No       | AWS region for Bedrock (`bedrock` only). Falls back to `AWS_REGION`, then `us-east-1`.                    |
| `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD` | No | USD per **million** input tokens, the unit vendors publish (`$0.02 / 1M` → `0.02`). Unset meters embeddings at `0`. See [Pricing embeddings](#pricing-embeddings). |

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
[`GET /api/v1/usage/events`](/docs/api/usage/list-usage-events) and counts
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

**The rate is deployment configuration, not a price book row.**
`EMBEDDING_INPUT_1M_TOKEN_PRICE_USD` prices every embedding this deployment
makes, and `cost_usd` is computed at write time as
`tokens × rate / 1,000,000`. `input_tokens` is the only dimension an embedding
has — the model emits no completion, so there is no output rate to price
against.

The variable is denominated per **million** tokens because that is how vendors
publish embedding rates, so the figure is copied across as written:

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_INPUT_1M_TOKEN_PRICE_USD=0.02
```

**Unset means zero.** A deployment that states no rate meters every embedding at
`cost_usd` of `0` rather than `null`, so an embedding never leaves a `cost_usd`
[quota](./quotas.md) unable to evaluate its window. That is the right answer for
a local model, which bills nothing per token; on a vendor-billed provider it
reports real spend as free, so the server logs a warning at startup naming the
variable. The recorded cost is frozen per event, so a rate set later prices the
*next* embedding, never an earlier one.

**The [price book](./usage.md#pricing) does not reach embeddings.** None of its
three tiers can price one, and a row naming the embedding model is ignored:

| Tier | Scope | Applies to embeddings? |
| --- | --- | --- |
| Provider instance | One `ai_provider_id` | No — an embedding event carries no provider record |
| Project + slug | One project's rate for a provider slug | No |
| Global default | Every project | No |

The embedding stack is configured per deployment rather than by an AI provider
record, so there is no provider instance to price and no per-project rate to
vary. Keeping the rate beside `EMBEDDING_MODEL` means the operator who chooses
the model sets its price in the same place.

An embedding is also never named in a `QUOTA_UNENFORCEABLE` refusal's
`unpriced_rows`, and never counts towards one: with no price book row to create,
naming it would point at a fix that does not exist.

Rows already in the price book for an embedding model keep explaining costs
frozen before this behaviour changed; they price nothing new.

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
