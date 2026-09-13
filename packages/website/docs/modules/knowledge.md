---
description: "Unified hybrid search across a project's documents and memory entries: a vector and a full-text query per store, fused by reciprocal rank and tagged by source."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Knowledge

## Overview

Unified search across a project's documents and memory entries: one endpoint, ranked by [hybrid retrieval](#hybrid-retrieval) — a vector query and a full-text query over each store, fused by reciprocal rank — and tagged by source.

Each result carries `source_type` (`"document"` or `"memory"`). Agents use the same layer for retrieval: [Agent with Persistent Memory — Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config) and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive.

In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md): the two stores, the search function, and injection are the **engine**; chunking and ranking are the **algorithms**; [ingestion rules](./ingestion-rules.md) are the seam for a bring-your-own extraction [tool](./tools.md).

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config)
- [Agent with Persistent Memory - Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly)
- [Agent over a Library of PDFs - Step 8 (Search the knowledge layer directly)](/docs/tutorials/agent-with-pdfs#step-8--search-the-knowledge-layer-directly-plan-d)
- [Agent over a Library of PDFs - Step 12 (Give the agent a knowledge tool)](/docs/tutorials/agent-with-pdfs#step-12--give-the-agent-a-knowledge-tool-plan-d)

## Data Model

### KnowledgeResult

A `KnowledgeResult` is a discriminated union on `source_type`; source-specific fields appear only for the matching type.

#### Common fields (all source types)

| Field         | Type                       | Description                                              |
| ------------- | -------------------------- | -------------------------------------------------------- |
| `source_type` | `"document"` \| `"memory"` | Discriminant for the knowledge source type               |
| `content`     | `string\|null`             | Text content of the result                               |
| `score`       | `number`                   | Fused relevance ranking; only present when `query` is used — see [Relevance scoring](#relevance-scoring) |
| `similarity_score` | `number`              | Raw cosine similarity (0–1); present on every `query` result, absent only in the embedding-degrade path — see [Relevance scoring](#relevance-scoring) |
| `created_at`  | `string`                   | ISO 8601 creation timestamp                              |
| `updated_at`  | `string`                   | ISO 8601 last-updated timestamp                          |

#### Document result (`source_type: "document"`)

| Field         | Type           | Description                                              |
| ------------- | -------------- | -------------------------------------------------------- |
| `document_id` | `string`       | Public document ID (`doc_` prefix)                       |
| `file_id`     | `string`       | ID of the underlying File record                         |
| `project_id`  | `string`       | ID of the owning project                                 |
| `path`        | `string\|null` | Logical path within the project (e.g. `/reports/q1.txt`) |
| `filename`    | `string`       | Original filename                                        |
| `size`        | `number`       | File size in bytes                                       |
| `title`       | `string\|null` | Document title (if set)                                  |
| `metadata`    | `object\|null` | Arbitrary JSON metadata, returned with keys in the exact casing they were written with — not converted between `snake_case` and `camelCase` like other fields |
| `tags`        | `object`       | Key-value tags associated with the document              |

#### Memory result (`source_type: "memory"`)

| Field         | Type     | Description                                    |
| ------------- | -------- | ---------------------------------------------- |
| `entry_id`    | `string` | Public memory entry ID (`mem_entry_` prefix)   |
| `memory_id`   | `string` | Public ID of the parent memory (`mem_` prefix) |
| `memory_name` | `string` | Human-readable name of the parent memory       |

## Key Concepts

### Search Modes

The [`POST /knowledge/search`](/docs/api/knowledge/search-knowledge) filters (at least one required):

| Parameter        | Type       | Description                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `query`          | `string`   | Search query — ranks results by [hybrid retrieval](#hybrid-retrieval)                      |
| `memory_ids`     | `string[]` | Search entries within these specific memories                                              |
| `document_paths` | `string[]` | Filter document results to paths starting with these prefixes                              |
| `document_ids`   | `string[]` | Filter document results to specific document IDs                                           |
| `tags`           | `object`   | Filter **both** stores to results whose `tags` contain every one of these key-value pairs (exact, case-sensitive). The only filter that scopes documents and memory entries at once |

With `query`, results carry `score` and `similarity_score`, ordered by descending `score`; `min_similarity`, `rrf_k` and `limit` apply. Walkthrough: [Agent with Persistent Memory — Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly).

Sources follow from the filters: documents when `query`, `document_paths`, or `document_ids` is passed; memory entries when `memory_ids` is. `tags` turns on **both**. A `query` plus a memory filter searches both, ranked together before `limit`.

`tags` is a key-value object, the same shape every tagged resource stores and the same one the IAM `soat:ResourceTag/<key>` condition reads. All pairs must match (JSONB containment), exact and case-sensitive:

```json
{ "query": "quarterly revenue", "tags": { "team": "finance", "env": "prod" } }
```

Against memory it matches at **entry granularity**: an entry is returned when its parent memory's tags contain the pairs (container-level, every entry returned) or when the entry's own `tags` do (that entry only) — see [Memories — Entry-Level Tag Filtering](./memories.md#entry-level-tag-filtering).

### Hybrid retrieval

A `query` runs **two** searches over each store, in parallel:

| Channel | Query | Ranked by | Finds |
| --- | --- | --- | --- |
| Vector | `embedding <=> $query` (pgvector) | cosine distance | paraphrase, synonym, topic |
| Lexical | `to_tsvector(content) @@ websearch_to_tsquery($query)` | `ts_rank_cd` | the exact token, verbatim |

Neither channel can answer for the other. A chunk that literally contains `SKU-4711` may sit far from the query in embedding space, and a chunk that answers a paraphrased question may share no token with it.

**The lexical channel is an exact-token and exact-phrase channel, by design.** The default text search configuration is `simple`, which removes no stopwords and does no stemming, and `websearch_to_tsquery` requires *every* term it produces. So a natural-language question almost never matches lexically — identifiers, error codes, product names and SKUs do. The vector channel carries the rest. Set `KNOWLEDGE_TEXT_SEARCH_CONFIG` to a language-specific configuration (`english`, `portuguese`, …) where the deployment's language is known and stemming is wanted; the trade is that the channel stops being exact.

If the lexical query fails — a text search configuration that does not exist is the realistic case — the search answers from the vector channel alone. If the embedding provider is unreachable, it answers from the lexical channel alone, and every result comes back without `similarity_score`.

**No full-text index ships with this.** `to_tsvector` is computed per candidate row, which is cheaper than an index to maintain until a corpus is large. Promote to a stored `tsvector` column with a GIN index when either holds: lexical p95 latency exceeds vector p95, or a project passes roughly 100k chunks.

### Relevance scoring

Two fields on every `query` result, with different contracts:

| Field | Contract |
| --- | --- |
| `score` | **Reciprocal rank fusion** value, higher is better. The *ordering* it produces is the contract; the absolute value is not, and nothing filters on it. |
| `similarity_score` | Raw **cosine similarity** (0–1) between the query embedding and the result. Pinned to that meaning — it is never redefined. |

`score` is `Σ 1 / (k + rank)` over the channels that ranked the result, `k = 60` by default. A result both channels rank outranks one only a single channel ranks highly, which is the point: agreement is better evidence than either signal alone. The value is deliberately **not** rescaled into 0–1 — that would lend it a stability it does not have, since RRF encodes position, not quality: `1 / (k + 1)` is the same number for the best result of a perfect ranking and the best of a useless one.

- `score` is comparable only *within one response*. Do not persist it, compare it across releases, or show it as a percentage.
- `similarity_score` is populated on every result of a `query` search, a lexical-only hit included. It is absent only when the embedding provider was unreachable and the search answered from the lexical channel alone.
- For a stable number, read `similarity_score`.

Each channel produces **one** ranking over the whole search, not one per store: documents and memory entries are queried separately because they are separate tables, and each channel's two result sets are merged on that channel's own value before fusion. Fusing them as separate rankings would let each store claim result slots by position — the tenth-best memory entry scoring the same as the tenth-best chunk, whatever either is worth.

### Relevance knobs

| Parameter | Default | Effect |
| --- | --- | --- |
| `min_similarity` | none | Minimum raw cosine a **vector** candidate must reach to be ranked at all, applied before fusion |
| `rrf_k` | `KNOWLEDGE_RRF_K`, itself `60` | The `k` in `1 / (k + rank)`; smaller weights the top of each ranking more heavily |
| `min_score` | none | **Deprecated** alias for `min_similarity`, removed in v2 |

`min_similarity` filters cosine, never `score`. A floor on a fused value would be a rank cutoff wearing a similarity knob's clothes.

**Lexical candidates are exempt from the floor.** A chunk that literally contains the searched token is the evidence; dropping it because its cosine is `0.4` is the failure hybrid retrieval exists to prevent.

**The floor filters, it does not refill.** It runs over the `limit` rows each store's vector query already took, so `limit: 10` with `min_similarity: 0.8` returning three rows means seven of that store's ten nearest fell below the floor — not that the corpus holds only three above it. Raise `limit` to widen the candidate set the floor is applied to.

`min_score` is the field's earlier name and keeps working unchanged. While ranking was single-signal `score` equaled `similarity_score`, so `min_score` has only ever filtered cosine — an existing value, per request or as `knowledge_config.min_score` on an agent, returns the same results it always did, plus the lexical hits the floor was never meant to exclude. `min_similarity` wins if both are sent.

### Ranking is approximate

Both vector columns carry an HNSW index, so `query` search is **approximate nearest neighbour**: it reads a bounded candidate list from the index instead of scanning every vector, keeping cost sub-linear in corpus size. The cost is exactness:

- **Recall against the true top-k is below 1.0.** A result that would rank 10th can be missed. Both fields keep their meaning; the set being ordered is not guaranteed to be the exact best k.
- **`min_similarity` needs re-tuning**: the candidate set feeding it changed.
- **Filters do not silently shrink the result set.** Scope, `paths`, `document_ids` and permission filters apply *after* the index proposes candidates, so a narrow scope could return fewer than `limit` rows; SOAT enables pgvector's iterative index scan on every search, widening the candidate list until `limit` is satisfied post-filter.

The last guarantee needs **pgvector 0.8 or newer** (`hnsw.iterative_scan`). On an older extension PostgreSQL discards the setting with a warning and a filtered search can come back short; see [Configuration](../self-hosting/configuration.md).

### Injected knowledge is untrusted input

Retrieved knowledge is partly **user-derived** (an entry written by [automatic extraction](./memories.md#automatic-extraction) contains what the user said). It is treated as data, never instruction:

- **Never injected with the `system` role.** [Agent knowledge injection](./agents.md#knowledge-config) delivers results as a `user` message inside a fenced `<knowledge>` block with a preamble framing it as reference material; the agent's `instructions` remain the only system input. Otherwise a phrase a user said once could become a persistent system-level instruction.
- **Extraction runs tool-less**: a plain completion with no tools and no injection, so quoted text cannot trigger a side effect while becoming memory entries.

This does not make retrieved content safe to act on: a tool call made after reading it is still authorized only by the agent's [boundary policy](./agents.md) and [guardrails](./guardrails.md). Scope the boundary policy assuming anything in reachable memories and documents may influence the agent.

### Project Scoping

`project_id` is optional; when omitted, accessible projects come from the caller's identity (API key scope, admin wildcard, or policy grants).

### Policy Conditions Narrow the Candidate Set

With `project_id`, the caller's `knowledge:SearchKnowledge` policy for documents is compiled into the search query itself: an SRN restriction and a `soat:ResourceTag/<key>` condition both become part of the filter a chunk has to satisfy to be ranked at all. A document the policy excludes is not a candidate — it does not consume a `limit` slot and never reaches the agent. Walk it end to end in [Tag-Based Access Control](../tutorials/tag-based-access-control.md).

Without `project_id` there is no single project policy to compile, and the search is scoped by project only.

### Result ceiling

`limit` defaults to 10 and is clamped to **100**; a larger value returns up to 100 rows rather than being refused.

### Retrieval baseline

Ranking changes are gated on a versioned golden query set, not on judgement. `packages/server/tests/eval/knowledge/golden.json` seeds a corpus — module-doc sections, synthetic documents carrying identifiers that occur exactly once, and curated memory entries — then scores 52 labeled queries through `searchKnowledge`.

```bash
pnpm --filter @soat/server eval:knowledge                    # score and gate
pnpm --filter @soat/server eval:knowledge --update-baseline  # rewrite the baseline
```

Metrics are computed over **raw result positions** at `limit: 10`, so a document occupying several slots counts as the caller experiences it; a hit is any chunk of the expected document.

| Scope         | recall@5 | recall@10 |    MRR |
| ------------- | -------: | --------: | -----: |
| Overall       |   0.8846 |    0.9231 | 0.8397 |
| `exact_token` |   1.0000 |    1.0000 | 1.0000 |
| `exact_name`  |   1.0000 |    1.0000 | 0.9667 |
| `entity`      |   1.0000 |    1.0000 | 0.9583 |
| `semantic`    |   0.6000 |    0.7333 | 0.5111 |

Those numbers are committed as `baseline.json`, and the run exits non-zero when recall@10 drops below it — overall or for any single kind. A ranking change lands with the diff of that file as its before/after table.

Two caveats on reading the absolute values:

- **The embedder is a stand-in.** CI has no embedding provider, so the eval substitutes a deterministic feature hasher that ranks by term overlap. Being itself lexical, it starts the `exact_token` row saturated — so the gate can prove [hybrid retrieval](#hybrid-retrieval) regresses nothing, but it cannot show the lexical channel's win; the proof of that is a targeted unit test over a chunk whose cosine sits below the floor. What the gate measures reliably is _change_.
- **The corpus tracks these docs.** Fixtures that name a `source` and a `section` are read from the module docs at seed time, so editing one of those sections moves the numbers. Re-run with `--update-baseline` and commit the diff.

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are stored (shared with Files)  |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend: `ollama`, `openai`, or `bedrock`          |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024`, and be at most `2000` |
| `OLLAMA_BASE_URL`      | No       | Ollama server URL, defaults to `http://localhost:11434`      |
| `KNOWLEDGE_TEXT_SEARCH_CONFIG` | No | PostgreSQL text search configuration for the lexical channel, defaults to `simple` — see [Hybrid retrieval](#hybrid-retrieval) |
| `KNOWLEDGE_RRF_K`      | No       | Deployment default for `rrf_k`, itself `60`. A request's own `rrf_k` wins |

## Examples

### Semantic search across documents and memories

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --query "quarterly revenue" \
  --memory-ids mem_xyz \
  --limit 5
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.knowledge.searchKnowledge({
  body: {
    project_id: 'proj_ABC',
    query: 'quarterly revenue',
    memory_ids: ['mem_xyz'],
    limit: 5,
  },
});
if (error) throw new Error(JSON.stringify(error));
console.log(data.results);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/knowledge/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "query": "quarterly revenue",
    "memory_ids": ["mem_xyz"],
    "limit": 5
  }'
```

</TabItem>
</Tabs>

### Path-scoped document retrieval (no query)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --document-paths /docs/products/
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.knowledge.searchKnowledge({
  body: {
    project_id: 'proj_ABC',
    document_paths: ['/docs/products/'],
  },
});
if (error) throw new Error(JSON.stringify(error));
console.log(data.results);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/knowledge/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "document_paths": ["/docs/products/"]
  }'
```

</TabItem>
</Tabs>
