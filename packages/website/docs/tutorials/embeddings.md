---
sidebar_position: 8
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Generating Embeddings

This tutorial shows how to use the SOAT [Embeddings](/docs/modules/embeddings) endpoint to convert text into numeric vectors, and how to feed those vectors into [Meilisearch](https://www.meilisearch.com/) for hybrid semantic search. You will:

1. Authenticate and call the endpoint with a single text input.
2. Embed a batch of texts in one request.
3. Configure a Meilisearch index with a `userProvided` embedder backed by SOAT.
4. Index documents using SOAT-generated embedding vectors.
5. Run a hybrid semantic search against the indexed documents.

By the end you will know how to generate embeddings via SOAT and wire them into any downstream pipeline — including Meilisearch's hybrid search engine.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (env vars, secrets), see [Advanced Configuration](/docs/getting-started/advanced-config).
- [Ollama](https://ollama.com) running locally with an embedding model pulled, for example:
  ```bash
  ollama pull qwen3-embedding:0.6b
  ```
- The server must have `EMBEDDING_PROVIDER=ollama` and `EMBEDDING_MODEL=qwen3-embedding:0.6b` set.
- [Meilisearch](https://www.meilisearch.com/docs/learn/getting_started/installation) running locally (Steps 3–5):
  ```bash
  docker run -d -p 7700:7700 getmeili/meilisearch:latest
  ```
- `curl` and `jq` available in your shell.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
export MEILI_URL=http://localhost:7700
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { Embeddings, createClient, createConfig } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_BASE_URL=http://localhost:5047
export MEILI_URL=http://localhost:7700
```

</TabItem>
</Tabs>

---

## Step 1 — Log in

Authenticate as admin to obtain a token. See [Users](/docs/modules/users#examples) for full authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const TOKEN = login.token;

const client = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047',
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Embed a single text

Pass `input` to embed one piece of text. The server returns `embedding` — a floating-point array whose length equals `EMBEDDING_DIMENSIONS` (default 1024).

See [Embeddings — Single vs batch](/docs/modules/embeddings#single-vs-batch) for when to choose single vs batch mode.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-embeddings \
  --input "SOAT is an open-source platform for building AI-powered applications." \
  | jq '{dimensions: (.embedding | length), first_values: .embedding[:3]}'
```

Expected output:

```json
{
  "dimensions": 1024,
  "first_values": [0.032, -0.041, 0.018]
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    input: 'SOAT is an open-source platform for building AI-powered applications.',
  },
});

console.log(data.embedding.length);      // 1024
console.log(data.embedding.slice(0, 3)); // first three values
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"SOAT is an open-source platform for building AI-powered applications."}' \
  | jq '{dimensions: (.embedding | length), first_values: .embedding[:3]}'
```

</TabItem>
</Tabs>

---

## Step 3 — Embed a batch of texts

Pass `inputs` (an array) to generate multiple vectors in a single request. The [Embeddings](/docs/modules/embeddings) module returns `embeddings` — an array of vectors in the same order as the inputs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-embeddings \
  --inputs '["Wooden cutting board", "Cast iron skillet", "Silicone spatula set", "Stainless steel mixing bowls"]' \
  | jq '{count: (.embeddings | length), dims: (.embeddings[0] | length)}'
```

Expected output:

```json
{
  "count": 4,
  "dims": 1024
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    inputs: [
      'Wooden cutting board',
      'Cast iron skillet',
      'Silicone spatula set',
      'Stainless steel mixing bowls',
    ],
  },
});

console.log(data.embeddings.length);    // 4
console.log(data.embeddings[0].length); // 1024
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["Wooden cutting board","Cast iron skillet","Silicone spatula set","Stainless steel mixing bowls"]}' \
  | jq '{count: (.embeddings | length), dims: (.embeddings[0] | length)}'
```

</TabItem>
</Tabs>

---

## Step 4 — Configure a Meilisearch index with a `userProvided` embedder

Meilisearch's [hybrid search](https://www.meilisearch.com/docs/capabilities/hybrid_search/getting_started) combines keyword ranking with semantic vector search. The `userProvided` embedder source lets you supply your own vectors at index time — so SOAT generates the embeddings and Meilisearch handles the search.

First, create the index and configure the embedder:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Create the kitchenware index
curl -s -X POST "$MEILI_URL/indexes" \
  -H "Content-Type: application/json" \
  -d '{"uid":"kitchenware","primaryKey":"id"}' | jq .

# Configure a userProvided embedder named "soat"
curl -s -X PATCH "$MEILI_URL/indexes/kitchenware/settings/embedders" \
  -H "Content-Type: application/json" \
  -d '{
    "soat": {
      "source": "userProvided",
      "dimensions": 1024
    }
  }' | jq .
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Use fetch directly — Meilisearch is outside the SOAT SDK scope
await fetch(`${MEILI_URL}/indexes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ uid: 'kitchenware', primaryKey: 'id' }),
});

await fetch(`${MEILI_URL}/indexes/kitchenware/settings/embedders`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    soat: { source: 'userProvided', dimensions: 1024 },
  }),
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$MEILI_URL/indexes" \
  -H "Content-Type: application/json" \
  -d '{"uid":"kitchenware","primaryKey":"id"}' | jq .

curl -s -X PATCH "$MEILI_URL/indexes/kitchenware/settings/embedders" \
  -H "Content-Type: application/json" \
  -d '{
    "soat": {
      "source": "userProvided",
      "dimensions": 1024
    }
  }' | jq .
```

</TabItem>
</Tabs>

The `dimensions` value must match the vector length produced by `EMBEDDING_DIMENSIONS` on your SOAT server (default `1024`).

---

## Step 5 — Index documents with SOAT-generated embeddings

Use SOAT's embeddings endpoint to compute vectors for each product description, then index the documents into Meilisearch. Each document receives a `_vectors.soat` field containing its embedding vector.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Define the product catalogue
PRODUCTS='[
  {"id":1,"name":"Wooden cutting board","category":"prep"},
  {"id":2,"name":"Cast iron skillet","category":"cookware"},
  {"id":3,"name":"Silicone spatula set","category":"utensils"},
  {"id":4,"name":"Stainless steel mixing bowls","category":"prep"}
]'

# Embed all names in one batch call
NAMES=$(echo "$PRODUCTS" | jq -r '[.[].name]')
EMBEDDINGS=$(soat create-embeddings --inputs "$NAMES" | jq '.embeddings')

# Merge each document with its embedding vector
DOCS=$(echo "$PRODUCTS" | jq --argjson vecs "$EMBEDDINGS" \
  '[to_entries[] | .value + {"_vectors": {"soat": $vecs[.key]}}]')

# Index into Meilisearch
curl -s -X POST "$MEILI_URL/indexes/kitchenware/documents" \
  -H "Content-Type: application/json" \
  -d "$DOCS" | jq .
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const products = [
  { id: 1, name: 'Wooden cutting board',      category: 'prep'     },
  { id: 2, name: 'Cast iron skillet',          category: 'cookware' },
  { id: 3, name: 'Silicone spatula set',       category: 'utensils' },
  { id: 4, name: 'Stainless steel mixing bowls', category: 'prep'  },
];

// Embed all product names in one batch request
const { data: embResult } = await Embeddings.createEmbeddings({
  client,
  body: { inputs: products.map((p) => p.name) },
});

// Attach embedding vectors as _vectors.soat
const docs = products.map((p, i) => ({
  ...p,
  _vectors: { soat: embResult.embeddings[i] },
}));

// Index into Meilisearch
await fetch(`${MEILI_URL}/indexes/kitchenware/documents`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(docs),
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Get batch embeddings from SOAT
EMBEDDINGS=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["Wooden cutting board","Cast iron skillet","Silicone spatula set","Stainless steel mixing bowls"]}' \
  | jq '.embeddings')

# Build Meilisearch document payload
DOCS=$(jq -n --argjson vecs "$EMBEDDINGS" '[
  {"id":1,"name":"Wooden cutting board","category":"prep","_vectors":{"soat":$vecs[0]}},
  {"id":2,"name":"Cast iron skillet","category":"cookware","_vectors":{"soat":$vecs[1]}},
  {"id":3,"name":"Silicone spatula set","category":"utensils","_vectors":{"soat":$vecs[2]}},
  {"id":4,"name":"Stainless steel mixing bowls","category":"prep","_vectors":{"soat":$vecs[3]}}
]')

curl -s -X POST "$MEILI_URL/indexes/kitchenware/documents" \
  -H "Content-Type: application/json" \
  -d "$DOCS" | jq .
```

</TabItem>
</Tabs>

---

## Step 6 — Run a hybrid semantic search

With documents indexed, use Meilisearch's hybrid search to combine keyword ranking with semantic similarity. Set `semanticRatio` between `0` (pure keyword) and `1` (pure vector). A value around `0.9` favours semantic meaning while still boosting exact keyword matches.

See [Meilisearch — Hybrid Search](https://www.meilisearch.com/docs/capabilities/hybrid_search/getting_started#choose-an-embedder-model) for full configuration options.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
curl -s -X POST "$MEILI_URL/indexes/kitchenware/search" \
  -H "Content-Type: application/json" \
  -d '{
    "q": "something to cook with on the stove",
    "hybrid": {
      "embedder": "soat",
      "semanticRatio": 0.9
    }
  }' | jq '[.hits[] | {id, name, category}]'
```

Expected output — the cast iron skillet ranks first because it is semantically closest to stovetop cooking:

```json
[
  { "id": 2, "name": "Cast iron skillet",           "category": "cookware" },
  { "id": 3, "name": "Silicone spatula set",         "category": "utensils" },
  { "id": 1, "name": "Wooden cutting board",         "category": "prep" },
  { "id": 4, "name": "Stainless steel mixing bowls", "category": "prep" }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const res = await fetch(`${MEILI_URL}/indexes/kitchenware/search`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    q: 'something to cook with on the stove',
    hybrid: { embedder: 'soat', semanticRatio: 0.9 },
  }),
});

const { hits } = await res.json();
console.log(hits.map((h) => h.name));
// ["Cast iron skillet", "Silicone spatula set", ...]
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$MEILI_URL/indexes/kitchenware/search" \
  -H "Content-Type: application/json" \
  -d '{
    "q": "something to cook with on the stove",
    "hybrid": {
      "embedder": "soat",
      "semanticRatio": 0.9
    }
  }' | jq '[.hits[] | {id, name, category}]'
```

</TabItem>
</Tabs>

Try varying `semanticRatio` to see how it shifts rankings:

| `semanticRatio` | Behaviour |
|---|---|
| `0.0` | Pure keyword — only exact matches rank |
| `0.5` | Balanced hybrid |
| `1.0` | Pure vector — ranking is entirely semantic |

---

## What's next

- **Re-embed on update** — when a document's text changes, call SOAT's embeddings endpoint again and re-index with the new `_vectors.soat` value. Only changed documents need reprocessing.
- **Multiple embedders** — configure additional named embedders on the same Meilisearch index (e.g. one for titles, one for descriptions) and choose which to use per query.
- **Agents with knowledge** — see [Agent with Persistent Memory](/docs/tutorials/memories-agent) to learn how SOAT uses embeddings automatically to inject relevant context before every agent generation, without any external search engine.
- **Knowledge search** — use `POST /api/v1/knowledge/search` to query across SOAT Documents and Memories using the same embedding model. See [Knowledge](/docs/modules/knowledge).
