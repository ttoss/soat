---
description: "Use the SOAT Embeddings endpoint to convert text into vectors and compute cosine similarity."
sidebar_position: 7
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Generating Embeddings

This tutorial shows how to use the SOAT [Embeddings](/docs/modules/embeddings) endpoint to convert text into numeric vectors and compute cosine similarity between them. You will:

1. Authenticate and call the endpoint with a single text input.
2. Embed a batch of texts in one request.
3. Implement a cosine similarity function in TypeScript.
4. Find the most semantically similar text in a collection.

By the end you will know how to generate embeddings via SOAT and wire them into any similarity-based feature — semantic search, recommendation, clustering, or a dedicated search engine like [Meilisearch](https://www.meilisearch.com/).

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (env vars, secrets), see [Configuration](/docs/getting-started/advanced-config).
- [Ollama](https://ollama.com) running locally with an embedding model pulled, for example:
  ```bash
  ollama pull qwen3-embedding:0.6b
  ```
- The server must have `EMBEDDING_PROVIDER=ollama` and `EMBEDDING_MODEL=qwen3-embedding:0.6b` set.
- `curl`, `jq`, and `node` available in your shell.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
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
import { SoatClient, Embeddings, createClient, createConfig } from '@soat/sdk';

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

## Step 4 — Compute cosine similarity

Cosine similarity measures how alike two vectors are, regardless of their magnitude. It returns a value between `-1` (opposite) and `1` (identical). Because all embeddings from the same SOAT deployment share the same vector space (see [Shared vector space](/docs/modules/embeddings#shared-vector-space)), cosine similarity is meaningful across any two texts.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
VECS=$(soat create-embeddings \
  --inputs '["I love cooking pasta", "My favourite dish is spaghetti"]' \
  | jq '.embeddings')
node << EOF
const vecs = $VECS;
const [a, b] = vecs;
const dot  = a.reduce((s, v, i) => s + v * b[i], 0);
const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
console.log('similarity:', (dot / (magA * magB)).toFixed(4));
EOF
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const cosineSimilarity = (a: number[], b: number[]): number => {
  const dot  = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
};

// Embed both texts in one batch request
const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    inputs: [
      'I love cooking pasta',
      'My favourite dish is spaghetti',
    ],
  },
});

const [vecA, vecB] = data.embeddings;

console.log('similarity:', cosineSimilarity(vecA, vecB).toFixed(4));
// → ~0.93  (highly similar)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
VECS=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["I love cooking pasta","My favourite dish is spaghetti"]}' \
  | jq '.embeddings')
node << EOF
const vecs = $VECS;
const [a, b] = vecs;
const dot  = a.reduce((s, v, i) => s + v * b[i], 0);
const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
console.log('similarity:', (dot / (magA * magB)).toFixed(4));
EOF
```

</TabItem>
</Tabs>

---

## Step 5 — Find the most similar text

Use cosine similarity to rank a collection of texts against a query. Embed everything in one batch call, then sort by similarity score.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ALL=$(soat create-embeddings \
  --inputs '["something to cook with on the stove","Wooden cutting board","Cast iron skillet","Silicone spatula set","Stainless steel mixing bowls"]' \
  | jq '.embeddings')
node << EOF
const vecs  = $ALL;
const items = ['Wooden cutting board', 'Cast iron skillet', 'Silicone spatula set', 'Stainless steel mixing bowls'];
const query = vecs[0];
const rest  = vecs.slice(1);
const cos = (a, b) => {
  const dot  = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (magA * magB);
};
items
  .map((name, i) => ({ name, score: cos(query, rest[i]) }))
  .sort((a, b) => b.score - a.score)
  .forEach(r => console.log(r.score.toFixed(4), r.name));
EOF
```

Expected output — the cast iron skillet ranks first because it is semantically closest to stovetop cooking:

```
0.8412  Cast iron skillet
0.7931  Silicone spatula set
0.7204  Stainless steel mixing bowls
0.6981  Wooden cutting board
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const cosineSimilarity = (a: number[], b: number[]): number => {
  const dot  = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
};

const query = 'something to cook with on the stove';

const items = [
  'Wooden cutting board',
  'Cast iron skillet',
  'Silicone spatula set',
  'Stainless steel mixing bowls',
];

// Embed query + all items in one batch call
const { data } = await Embeddings.createEmbeddings({
  client,
  body: { inputs: [query, ...items] },
});

const [queryVec, ...itemVecs] = data.embeddings;

const ranked = items
  .map((name, i) => ({ name, score: cosineSimilarity(queryVec, itemVecs[i]) }))
  .sort((a, b) => b.score - a.score);

ranked.forEach((r) => console.log(r.score.toFixed(4), r.name));
// 0.8412  Cast iron skillet        ← most similar to "cook on the stove"
// 0.7931  Silicone spatula set
// 0.7204  Stainless steel mixing bowls
// 0.6981  Wooden cutting board
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ALL=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["something to cook with on the stove","Wooden cutting board","Cast iron skillet","Silicone spatula set","Stainless steel mixing bowls"]}' \
  | jq '.embeddings')
node << EOF
const vecs  = $ALL;
const items = ['Wooden cutting board', 'Cast iron skillet', 'Silicone spatula set', 'Stainless steel mixing bowls'];
const query = vecs[0];
const rest  = vecs.slice(1);
const cos = (a, b) => {
  const dot  = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (magA * magB);
};
items
  .map((name, i) => ({ name, score: cos(query, rest[i]) }))
  .sort((a, b) => b.score - a.score)
  .forEach(r => console.log(r.score.toFixed(4), r.name));
EOF
```

</TabItem>
</Tabs>

---

## What's next

- **Production-scale search** — for large document collections, pass SOAT-generated vectors to a dedicated vector search engine. [Meilisearch](https://www.meilisearch.com/docs/capabilities/hybrid_search/getting_started) supports a `userProvided` embedder source that accepts your own vectors for hybrid keyword + semantic search. [Qdrant](https://qdrant.tech/documentation/) and [pgvector](https://github.com/pgvector/pgvector) are good alternatives.
- **Re-embed on update** — when a document's text changes, call SOAT's embeddings endpoint again and update the stored vector. Only changed documents need reprocessing.
- **Agents with knowledge** — see [Agent with Persistent Memory](/docs/tutorials/memories-agent) to learn how SOAT uses embeddings automatically to inject relevant context before every agent generation, without any external search engine.
- **Knowledge search** — use `POST /api/v1/knowledge/search` to query across SOAT Documents and Memories using the same embedding model. See [Knowledge](/docs/modules/knowledge).
