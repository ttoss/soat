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
| `EMBEDDING_DIMENSIONS`| No       | Vector dimensionality. Must match the model output (default: `1024`).                                    |
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

## Key Concepts

### Single vs batch

Pass `input` (a string) for a single vector, or `inputs` (an array of strings) for multiple vectors in one request. Batch calls reduce per-request overhead. Both can be combined in one call.

### Shared vector space

All embeddings produced by a given SOAT deployment are in the same vector space because they use the same model. Cosine similarity between any two vectors produced by the same server is meaningful. Vectors from different deployments or models are not comparable.

### 503 when unconfigured

If `EMBEDDING_PROVIDER` or `EMBEDDING_MODEL` is not set, the server returns `503 EMBEDDING_NOT_CONFIGURED`. This is a configuration error, not a caller error.

## Examples

### Single text

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-embeddings --input "The quick brown fox jumps over the lazy dog."
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
  body: { input: 'The quick brown fox jumps over the lazy dog.' },
});

console.log(data.embedding.length); // 1024 (depends on EMBEDDING_DIMENSIONS)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"The quick brown fox jumps over the lazy dog."}' \
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
