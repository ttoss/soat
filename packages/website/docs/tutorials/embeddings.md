---
sidebar_position: 8
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Generating Embeddings

This tutorial shows how to use the SOAT [Embeddings](/docs/modules/embeddings) endpoint to convert text into numeric vectors. You will:

1. Authenticate and call the endpoint with a single text input.
2. Embed a batch of texts in one request.
3. Compute the cosine similarity between two vectors to measure semantic relatedness.

By the end you will know how to produce embeddings for any text and use them in your own downstream pipelines — similarity search, clustering, classification, or feeding a custom index.

## Prerequisites

- SOAT running locally with an embedding model configured. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (env vars, secrets), see [Advanced Configuration](/docs/getting-started/advanced-config).
- [Ollama](https://ollama.com) running locally with an embedding model pulled, for example `ollama pull qwen3-embedding:0.6b`.
- Server is at `http://localhost:5047`.
- The server must have `EMBEDDING_PROVIDER` and `EMBEDDING_MODEL` set in its environment.

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

console.log(data.embedding.length);    // 1024
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
  --inputs '["The dog barked at the mailman.", "The cat slept on the sofa.", "Machine learning is a subset of artificial intelligence."]' \
  | jq '{count: (.embeddings | length), dims: (.embeddings[0] | length)}'
```

Expected output:

```json
{
  "count": 3,
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
      'The dog barked at the mailman.',
      'The cat slept on the sofa.',
      'Machine learning is a subset of artificial intelligence.',
    ],
  },
});

console.log(data.embeddings.length);      // 3
console.log(data.embeddings[0].length);   // 1024
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["The dog barked at the mailman.","The cat slept on the sofa.","Machine learning is a subset of artificial intelligence."]}' \
  | jq '{count: (.embeddings | length), dims: (.embeddings[0] | length)}'
```

</TabItem>
</Tabs>

---

## Step 4 — Compute cosine similarity

Embeddings encode meaning as direction in vector space. Two texts with similar meaning will have vectors that point in nearly the same direction — cosine similarity close to 1. Unrelated texts will have similarity close to 0.

Embed two texts in a single batch call, then compute their cosine similarity:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Embed two texts together
RESULT=$(soat create-embeddings \
  --inputs '["I love programming in TypeScript.", "I enjoy writing code in TypeScript."]')

VEC_A=$(echo "$RESULT" | jq '.embeddings[0]')
VEC_B=$(echo "$RESULT" | jq '.embeddings[1]')

# Compute dot product and magnitudes using jq
python3 - <<'EOF'
import json, sys, math

result = json.loads(sys.stdin.read())
a = result['embeddings'][0]
b = result['embeddings'][1]

dot   = sum(x * y for x, y in zip(a, b))
mag_a = math.sqrt(sum(x * x for x in a))
mag_b = math.sqrt(sum(x * x for x in b))
similarity = dot / (mag_a * mag_b)

print(f"Cosine similarity: {similarity:.4f}")
EOF <<< "$RESULT"
```

Expected output (values vary by model):

```
Cosine similarity: 0.9523
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    inputs: [
      'I love programming in TypeScript.',
      'I enjoy writing code in TypeScript.',
    ],
  },
});

const [a, b] = data.embeddings;

const dot   = a.reduce((sum, val, i) => sum + val * b[i], 0);
const magA  = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
const magB  = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
const similarity = dot / (magA * magB);

console.log(`Cosine similarity: ${similarity.toFixed(4)}`); // e.g. 0.9523
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RESULT=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["I love programming in TypeScript.","I enjoy writing code in TypeScript."]}')

python3 - <<'EOF'
import json, sys, math

result = json.loads(sys.stdin.read())
a = result['embeddings'][0]
b = result['embeddings'][1]

dot   = sum(x * y for x, y in zip(a, b))
mag_a = math.sqrt(sum(x * x for x in a))
mag_b = math.sqrt(sum(x * x for x in b))
similarity = dot / (mag_a * mag_b)

print(f"Cosine similarity: {similarity:.4f}")
EOF <<< "$RESULT"
```

</TabItem>
</Tabs>

Now try two semantically unrelated texts to see the similarity drop:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RESULT=$(soat create-embeddings \
  --inputs '["I love programming in TypeScript.", "The weather in São Paulo is hot today."]')

python3 - <<'EOF'
import json, sys, math

result = json.loads(sys.stdin.read())
a = result['embeddings'][0]
b = result['embeddings'][1]

dot   = sum(x * y for x, y in zip(a, b))
mag_a = math.sqrt(sum(x * x for x in a))
mag_b = math.sqrt(sum(x * x for x in b))
similarity = dot / (mag_a * mag_b)

print(f"Cosine similarity: {similarity:.4f}")
EOF <<< "$RESULT"
```

Expected output (values vary by model):

```
Cosine similarity: 0.3148
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: data2 } = await Embeddings.createEmbeddings({
  client,
  body: {
    inputs: [
      'I love programming in TypeScript.',
      'The weather in São Paulo is hot today.',
    ],
  },
});

const [c, d] = data2.embeddings;

const dot2  = c.reduce((sum, val, i) => sum + val * d[i], 0);
const magC  = Math.sqrt(c.reduce((sum, val) => sum + val * val, 0));
const magD  = Math.sqrt(d.reduce((sum, val) => sum + val * val, 0));

console.log(`Cosine similarity: ${(dot2 / (magC * magD)).toFixed(4)}`); // e.g. 0.3148
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RESULT=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs":["I love programming in TypeScript.","The weather in São Paulo is hot today."]}')

python3 - <<'EOF'
import json, sys, math

result = json.loads(sys.stdin.read())
a = result['embeddings'][0]
b = result['embeddings'][1]

dot   = sum(x * y for x, y in zip(a, b))
mag_a = math.sqrt(sum(x * x for x in a))
mag_b = math.sqrt(sum(x * x for x in b))
similarity = dot / (mag_a * mag_b)

print(f"Cosine similarity: {similarity:.4f}")
EOF <<< "$RESULT"
```

</TabItem>
</Tabs>

The gap between the two scores shows the model is capturing semantic meaning, not just lexical overlap.

---

## Step 5 — Combine single and batch in one call

You can pass both `input` and `inputs` in the same request. The response will contain both `embedding` and `embeddings`. This is useful when you want to compare one query against a fixed set of candidates without making two round trips.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-embeddings \
  --input "What is the capital of France?" \
  --inputs '["Paris is the capital city of France.", "Berlin is the capital of Germany.", "The Eiffel Tower is in Paris."]' \
  | jq '{
      query_dims: (.embedding | length),
      candidates: (.embeddings | length)
    }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await Embeddings.createEmbeddings({
  client,
  body: {
    input: 'What is the capital of France?',
    inputs: [
      'Paris is the capital city of France.',
      'Berlin is the capital of Germany.',
      'The Eiffel Tower is in Paris.',
    ],
  },
});

// Rank candidates by cosine similarity to the query
const query = data.embedding;
const ranked = data.embeddings
  .map((vec, i) => {
    const dot  = query.reduce((s, v, j) => s + v * vec[j], 0);
    const magQ = Math.sqrt(query.reduce((s, v) => s + v * v, 0));
    const magV = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return { index: i, score: dot / (magQ * magV) };
  })
  .sort((a, b) => b.score - a.score);

console.log('Best match index:', ranked[0].index);
// → 0 ("Paris is the capital city of France.")
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/embeddings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "What is the capital of France?",
    "inputs": [
      "Paris is the capital city of France.",
      "Berlin is the capital of Germany.",
      "The Eiffel Tower is in Paris."
    ]
  }' \
  | jq '{query_dims: (.embedding | length), candidates: (.embeddings | length)}'
```

</TabItem>
</Tabs>

---

## What's next

- **Semantic search** — Index your own documents by storing their embeddings and performing nearest-neighbor search. SOAT already does this internally for [Documents](/docs/modules/documents) and [Memories](/docs/modules/memories); the embeddings endpoint gives you the same capability for any external store.
- **Clustering** — Group customer feedback, support tickets, or log messages by semantic similarity using k-means or DBSCAN on the returned vectors.
- **Agents with knowledge** — See [Agent with Persistent Memory](/docs/tutorials/memories-agent) to learn how SOAT uses embeddings automatically to inject relevant context before every agent generation.
- **Knowledge search** — Use `POST /api/v1/knowledge/search` to query across documents and memories using the same embedding model. See [Knowledge](/docs/modules/knowledge).
