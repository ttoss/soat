---
description: "Generate numeric vector representations of text using SOAT's configured embedding model."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Embeddings

Generate numeric vector representations of text using the server's configured embedding model.

## Overview

One call accepts one or more strings and returns floating-point vectors for similarity scoring, clustering, classification, or a custom search index.

The model is configured server-side (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`; backends `ollama`, `openai`, `bedrock`). Callers do not choose it, so all vectors in a deployment share one space.

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

### Batch size

`inputs` accepts at most **256** values per request (each a model call); larger batches are refused with `VALIDATION_FAILED` (`400`).

## Data Model

Stateless; nothing is stored. The response shape depends on the inputs:

| Field        | Type         | Description                                                              |
| ------------ | ------------ | ------------------------------------------------------------------------ |
| `embedding`  | `number[]`   | Returned when `input` (single string) is provided.                       |
| `embeddings` | `number[][]` | Returned when `inputs` (array of strings) is provided.                   |

Both fields can be present if the request includes both `input` and `inputs`.

Optional `project_id` names the project billed; see [Metering](#metering).

## Key Concepts

### Single vs batch

`input` (string) for one vector, `inputs` (array) for many; both may be combined.

### Shared vector space

All embeddings from one deployment share a vector space, so cosine similarity between them is meaningful; vectors from other deployments or models are not comparable.

### Metering

Every embedding call is metered as an `llm_tokens` usage event with `source` `embedding`, whatever the origin: this endpoint, ingestion, a memory write, an `embedding_similarity` scorer, or a knowledge-search query. Spend appears in [`GET /api/v1/usage/events`](/docs/api/usage/list-usage-events) and counts towards `cost_usd` and `tokens` [quotas](./quotas.md).

A usage event belongs to a project, so an embedding call needs one:

| Call | Billed to |
| --- | --- |
| [`POST /api/v1/embeddings`](/docs/api/embeddings/create-embeddings) with `project_id` | that project — the caller must be able to write to it |
| The same call from a project-scoped credential | the credential's project |
| The same call with neither | nothing — the call is served but not metered |
| Ingestion, memory, evaluation | the document's, memory's or run's project |
| A knowledge search | the project searched, when the search is scoped to exactly one |

### Pricing embeddings

**The rate is deployment configuration, not a price book row.** `EMBEDDING_INPUT_1M_TOKEN_PRICE_USD` prices every embedding; `cost_usd` = `tokens × rate / 1,000,000` at write time. `input_tokens` is the only dimension; there is no output rate.

Per **million** tokens, as vendors publish, so the figure is copied as written:

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_INPUT_1M_TOKEN_PRICE_USD=0.02
```

**Unset means zero.** With no rate, every embedding is metered at `cost_usd` `0` (not `null`), so a `cost_usd` [quota](./quotas.md) window always evaluates. Right for a local model; on a vendor-billed provider it reports spend as free, so the server warns at startup naming the variable. Cost is frozen per event; a rate set later prices the *next* embedding.

**The [price book](./usage.md#pricing) does not reach embeddings.** A row naming the embedding model is ignored:

| Tier | Scope | Applies to embeddings? |
| --- | --- | --- |
| Provider instance | One `ai_provider_id` | No — an embedding event carries no provider record |
| Project + slug | One project's rate for a provider slug | No |
| Global default | Every project | No |

The embedding stack is per deployment, not an AI provider record, so there is no instance or per-project rate to price; the operator who picks `EMBEDDING_MODEL` sets its price beside it.

An embedding is never named in a `QUOTA_UNENFORCEABLE` refusal's `unpriced_rows` and never counts towards one.

Existing price book rows for an embedding model explain costs frozen before this behaviour changed; they price nothing new.

### 503 when unconfigured

Without `EMBEDDING_PROVIDER` or `EMBEDDING_MODEL`, the server returns `503 EMBEDDING_NOT_CONFIGURED` (a configuration error).

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
