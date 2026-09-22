---
description: "Unified hybrid search across a project's documents and memories: a vector and a full-text query per store, fused by reciprocal rank and tagged by source."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Knowledge

## Overview

Unified search across a project's documents and memories: one endpoint, ranked by [hybrid retrieval](#hybrid-retrieval) — a vector query and a full-text query over each store, fused by reciprocal rank — and tagged by source.

Each result carries `source_type` (`"document"` or `"memory"`). Agents use the same layer for retrieval: [Agent with Persistent Memory — Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config) and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive.

In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md): the two stores, the search function, and injection are the **engine**; chunking and ranking are the **algorithms**; [ingestion rules](./ingestion-rules.md) are the seam for a bring-your-own extraction [tool](./tools.md).

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config)
- [Agent with Persistent Memory - Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly)
- [Agent over a Library of PDFs - Step 8 (Search the knowledge layer directly)](/docs/tutorials/agent-with-pdfs#step-8--search-the-knowledge-layer-directly-plan-d)
- [Agent over a Library of PDFs - Step 12 (Give the agent a knowledge tool)](/docs/tutorials/agent-with-pdfs#step-12--give-the-agent-a-knowledge-tool-plan-d)
- [Measuring Retrieval Quality - Step 6 (Compute recall@k and MRR)](/docs/tutorials/measure-retrieval-quality#step-6--compute-recallk-and-mrr)
- [Measuring Retrieval Quality - Step 7 (Read a knob off the table)](/docs/tutorials/measure-retrieval-quality#step-7--read-a-knob-off-the-table)

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
| `signals`     | `object`                   | Which channels ranked this result and at what position; only present when `query` is used — see [Reading a result](#reading-a-result) |
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
| `memory_id`         | `string` | Public memory ID (`mem_` prefix)                            |
| `memory_store_id`   | `string` | Public ID of the parent memory store (`mstore_` prefix)     |
| `memory_store_name` | `string` | Human-readable name of the parent memory store              |

## Key Concepts

### Search Modes

The [`POST /knowledge/search`](/docs/api/knowledge/search-knowledge) filters (at least one required):

| Parameter        | Type       | Description                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `query`          | `string`   | Search query — ranks results by [hybrid retrieval](#hybrid-retrieval)                      |
| `memory_store_ids` | `string[]` | Search memories within these specific memory stores                                        |
| `document_paths` | `string[]` | Filter document results to paths starting with these prefixes                              |
| `document_ids`   | `string[]` | Filter document results to specific document IDs                                           |
| `tags`           | `object`   | Filter **both** stores to results whose `tags` contain every one of these key-value pairs (exact, case-sensitive) |
| `include_documents` | `boolean` | Default `true`. `false` leaves the document store out of this search |
| `include_memories`  | `boolean` | Default `true`. `false` leaves the memory store out of this search |

With `query`, results carry `score` and `similarity_score`, ordered by descending `score`; `min_similarity`, `rrf_k` and `limit` apply. Walkthrough: [Agent with Persistent Memory — Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly).

### Platform-written documents

Each [conversation](./conversations.md) turn is a document under
`/.system/conversations/`, so a bare `query` would rank chat history against
the knowledge a project deliberately uploaded. It does not: a search leaves
[the reserved root](./files.md#the-reserved-system-root) out unless
`document_paths` names a directory inside it.

```json
{ "query": "refund policy", "document_paths": ["/.system/conversations/"] }
```

Turns reach the vector channel only when their conversation's
[`retrieval`](./conversations.md#retrieval) is `embed`; otherwise they are
still matched by the full-text channel.

Each turn is stamped with the conversation, its owner, the agent and the role
([what a turn is stamped with](./conversations.md#what-a-turn-is-stamped-with)),
so `tags` selects them without naming a path:

| Question | Request |
| --- | --- |
| What did this customer say before? | `tags: { "system.actor": "actor_…" }` — turns and the facts distilled from them |
| Earlier in this conversation, past the context window | `tags: { "system.conversation": "conv_…" }` |
| Where did users mention refund delays? | `query` + `tags: { "system.role": "user" }` |

A `system.*` key in `tags` reaches the reserved root on its own, so it composes
with `query` without `document_paths`.

### Which stores a search reads

`query` and `tags` name no store, so they reach **both**. The store-specific filters narrow *within* a store: `document_paths`, `document_ids` and `metadata` for documents, `memory_store_ids` for memories.

| Request | Documents | Memories |
| --- | --- | --- |
| `query` alone | ✅ | ✅ |
| `tags` alone | ✅ | ✅ |
| `query` + `memory_store_ids` | ✅ (project-wide) | ✅ (those stores) |
| `document_paths` alone | ✅ (those paths) | — |
| `metadata` alone | ✅ (matching bags) | — |
| `memory_store_ids` alone | — | ✅ (those stores) |

`include_documents: false` and `include_memories: false` take a store out, and a filter naming the other store never overrides them — `{ document_paths, include_documents: false }` returns nothing rather than quietly re-enabling documents. Both `false` is `400 VALIDATION_FAILED`.

Results from both stores are ranked together before `limit` applies, so a search reaching both does not reserve slots for either.

`tags` is a key-value object, the same shape every tagged resource stores and the same one the IAM `soat:ResourceTag/<key>` condition reads. All pairs must match (JSONB containment), exact and case-sensitive:

```json
{ "query": "quarterly revenue", "tags": { "team": "finance", "env": "prod" } }
```

`metadata` is the structured question the document listing reads, in the same shape — one grammar, so a filter written for [`GET /api/v1/documents`](/docs/api/documents/list-documents) holds here. It narrows documents alone, because a memory carries no such bag. See [Documents — Metadata filters](./documents.md#metadata-filters) for the operators; an ordering compares by the operand's own type.

```json
{ "query": "quarterly revenue", "metadata": { "quarter": "Q1", "revision": { "gte": 3 } } }
```

Against memories `tags` matches at **memory granularity**: a memory is returned when its parent store's tags contain the pairs (store-level, every memory returned) or when the memory's own `tags` do (that memory only) — see [Memories — Memory-Level Tag Filtering](./memories.md#memory-level-tag-filtering).

### Hybrid retrieval

A `query` runs **two** searches over each store, in parallel:

| Channel | Query | Ranked by | Finds |
| --- | --- | --- | --- |
| Vector | `embedding <=> $query` (pgvector) | cosine distance | paraphrase, synonym, topic |
| Lexical | `to_tsvector(content) @@ websearch_to_tsquery($query)` | `ts_rank_cd` | the exact token, verbatim |

Neither channel can answer for the other. A chunk that literally contains `SKU-4711` may sit far from the query in embedding space, and a chunk that answers a paraphrased question may share no token with it.

A row carrying no embedding is not a vector candidate: it is reachable through the lexical channel only, whatever the scope, and it never takes a vector slot from a row that has one.

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

Each channel produces **one** ranking over the whole search, not one per store: documents and memories are queried separately because they are separate tables, and each channel's two result sets are merged on that channel's own value before fusion. Fusing them as separate rankings would let each store claim result slots by position — the tenth-best memory scoring the same as the tenth-best chunk, whatever either is worth.

### Reading a result

Three fields, three questions:

| Field | Answers |
| --- | --- |
| `score` | **Where** the result landed — the fused order. |
| `similarity_score` | **How close** it is to the query, as raw cosine. |
| `signals` | **How it got there** — which channels ranked it, and at what position in each. |

`signals` carries a 1-based rank per channel, and omits a channel that did not return the result at all:

```json
{ "signals": { "lexical": 1 } }                 // pure token hit; the vector channel missed it
{ "signals": { "vector": 1 } }                  // nearest by cosine; contains none of the query's terms
{ "signals": { "vector": 2, "lexical": 1 } }    // both found it — this is what fusion promotes
```

These are the parts `score` is the sum of, and the sum cannot be taken apart afterwards: `Σ 1/(k + rank)` gives `2/61` for a result both channels put first and `1/31` for one a single channel put thirtieth, and those are the same number. `signals` is what tells them apart.

Use it to answer "why is this here?" without a harness — a result you expected to lead that reads `{ "vector": 8 }` was never found lexically, which is a query-phrasing or text-search-configuration problem, not a ranking one. It is diagnostic only: nothing filters or sorts on it, and a channel that degraded is absent from every result in the response.

### Relevance knobs

| Parameter | Default | Effect |
| --- | --- | --- |
| `min_similarity` | none | Minimum raw cosine a **vector** candidate must reach to be ranked at all, applied before fusion |
| `rrf_k` | `KNOWLEDGE_RRF_K`, itself `60` | The `k` in `1 / (k + rank)`; smaller weights the top of each ranking more heavily |
| `recency_half_life_days` | `KNOWLEDGE_RECENCY_HALF_LIFE_DAYS`, itself `0` (off) | Half-life of a decay applied to **memory** results after fusion; `0` disables it |

`min_similarity` filters cosine, never `score`. A floor on a fused value would be a rank cutoff wearing a similarity knob's clothes.

**Lexical candidates are exempt from the floor.** A chunk that literally contains the searched token is the evidence; dropping it because its cosine is `0.4` is the failure hybrid retrieval exists to prevent.

**The floor filters, it does not refill.** It runs over the `limit` rows each store's vector query already took, so `limit: 10` with `min_similarity: 0.8` returning three rows means seven of that store's ten nearest fell below the floor — not that the corpus holds only three above it. Raise `limit` to widen the candidate set the floor is applied to.

The agent record spells the same floor `knowledge_config.min_score` — one field, two surfaces, so a value set on an agent and a value sent per request mean the same cosine.

#### Recency blend

A memory decays in usefulness; a paragraph of a manual does not. With a half-life set, each **memory** result's fused `score` is multiplied after fusion by

```txt
2 ^ (-age_in_days / recency_half_life_days)
```

so at equal relevance a fresh fact outranks a stale one. Document results are never touched, and `similarity_score` — raw cosine — is never touched either.

- **`0` disables the blend, at either level.** Zero days is not a meaningful half-life, so the value is a switch rather than a lower bound. It is also the default at both levels, so an upgrade reorders nothing until someone turns it on. A request `recency_half_life_days: 0` turns off a deployment-wide decay for that one query — the archival search on a deployment that otherwise wants freshness.
- **Days, as a float.** `0.5` is twelve hours; `30` stays readable.
- **Age is read from `updated_at`, not `created_at`**, so a [consolidation merge](./memories.md#write-algorithm) that re-asserts a fact refreshes it instead of ageing out knowledge the system keeps re-confirming. Every write to the memory counts as a re-assertion — a `PATCH` of its content and a tag edit included. A tag-only edit therefore resets a fact's age to zero.
- **An invalid value falls back rather than failing.** A negative or non-finite `recency_half_life_days` resolves to the deployment value, then to `0`, the same way `rrf_k` does.
- **The clock is read once per response**, so two results in one answer are always ordered against the same instant.
- **Retrieval only.** The memory write algorithm's duplicate shortlist reads raw cosine and is unaffected: a memory old enough for the blend to bury is still the duplicate a restatement of it merges into.

How many ranks a half-life costs depends on `rrf_k`, and on a corpus mixing documents and memories it is never free. Figures and the method for choosing a value: [Retrieval Quality](../advanced/retrieval-quality.md).

### Ranking is approximate

Both vector columns carry an HNSW index, so `query` search is **approximate nearest neighbour**: it reads a bounded candidate list from the index instead of scanning every vector, keeping cost sub-linear in corpus size. The cost is exactness:

- **Recall against the true top-k is below 1.0.** A result that would rank 10th can be missed. Both fields keep their meaning; the set being ordered is not guaranteed to be the exact best k.
- **`min_similarity` needs re-tuning**: the candidate set feeding it changed.
- **Filters do not silently shrink the result set.** Scope, `paths`, `document_ids` and permission filters apply *after* the index proposes candidates, so a narrow scope could return fewer than `limit` rows; SOAT enables pgvector's iterative index scan on every search, widening the candidate list until `limit` is satisfied post-filter.

The last guarantee needs **pgvector 0.8 or newer** (`hnsw.iterative_scan`). On an older extension PostgreSQL discards the setting with a warning and a filtered search can come back short; see [Configuration](../self-hosting/configuration.md).

### Injected knowledge is untrusted input

Retrieved knowledge is partly **user-derived** (a memory a [memory rule](./memories.md#memory-rules) wrote contains what the user said). It is treated as data, never instruction:

- **Never injected with the `system` role.** [Agent knowledge injection](./agents.md#knowledge-config) delivers results as a `user` message inside a fenced `<knowledge>` block with a preamble framing it as reference material; the agent's `instructions` remain the only system input. Otherwise a phrase a user said once could become a persistent system-level instruction.
- **Extraction runs tool-less**: a plain completion with no tools and no injection, so quoted text cannot trigger a side effect while becoming memories.

This does not make retrieved content safe to act on: a tool call made after reading it is still authorized only by the agent's [boundary policy](./agents.md) and [guardrails](./guardrails.md). Scope the boundary policy assuming anything in reachable memory stores and documents may influence the agent.

### Project Scoping

`project_id` is optional; when omitted, accessible projects come from the caller's identity (API key scope, admin wildcard, or policy grants).

### Policy Conditions Narrow the Candidate Set

With `project_id`, the caller's `knowledge:SearchKnowledge` policy for documents is compiled into the search query itself: an SRN restriction and a `soat:ResourceTag/<key>` condition both become part of the filter a chunk has to satisfy to be ranked at all. A document the policy excludes is not a candidate — it does not consume a `limit` slot and never reaches the agent. Walk it end to end in [Tag-Based Access Control](../tutorials/tag-based-access-control.md).

Without `project_id` there is no single project policy to compile, and the search is scoped by project only.

### Result ceiling

`limit` defaults to 10 and is clamped to **100**; a larger value returns up to 100 rows rather than being refused.

### Retrieval baseline

Ranking changes are gated on a versioned golden query set (`packages/server/tests/eval/knowledge/golden.json`, figures in `baseline.json`); the run exits non-zero when recall@10 or MRR drops below the baseline, overall or for any single kind. It is a contributor harness, not a way to measure a deployment.

```bash
pnpm --filter @soat/server eval:knowledge                    # score and gate
pnpm --filter @soat/server eval:knowledge --update-baseline  # rewrite the baseline
```

Each query carries a `kind`, and the gate applies per kind as well as overall, so a change that lifts the headline number while breaking one kind still fails. Two kinds are worth knowing before reading a result:

- **`freshness`** pairs two statements of one fact in a **single** store, close enough that the query cannot separate them and only `age_days` says which is current. The corpus store raises its own `supersede_threshold` so the pair survives the write path; on the product defaults the older twin would be invalidated and never reach the corpus. Its MRR is well under 1.0 by construction — no shipped mechanism orders by age, since `recency_half_life_days` defaults to `0`.
- **`exact_token`** is saturated at recall 1.0: the eval's embedder is itself lexical, so it cannot show a lexical-vs-vector win. The harness proves a change regresses nothing; it does not prove a gain.

Metric definitions, the baseline table, its caveats and the per-deployment method: [Retrieval Quality](../advanced/retrieval-quality.md), [Measuring Retrieval Quality](../tutorials/measure-retrieval-quality.md).

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
  --memory-store-ids mstore_xyz \
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
    memory_store_ids: ['mstore_xyz'],
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
    "memory_store_ids": ["mstore_xyz"],
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
