---
description: 'How knowledge search ranking is measured: recall@k and MRR over raw result positions, the three rules for reading a per-slice table, what a score multiplier costs on fused RRF output, and the contributor baseline that gates ranking changes.'
keywords:
  - retrieval quality
  - recall@k
  - mean reciprocal rank
  - reciprocal rank fusion
  - knowledge search
---

# Retrieval Quality

[Knowledge search](../modules/knowledge.md) exposes three ranking knobs, `min_similarity`, `rrf_k` and `recency_half_life_days`. None has a default that is right for every corpus, so a knob is set from a measurement, never from this page. This page defines the measurement; [Measuring Retrieval Quality](/docs/tutorials/measure-retrieval-quality) runs it against a corpus you own.

## Metrics

A golden set is a list of rows `{slice, query, expected}`, where `expected` is the id (`document_id` or `entry_id`) that should top the ranking. Each row is searched once at a fixed `limit`; `rank` is the 1-based position of `expected` in the response, `0` when it is absent.

| Metric | Per row | Reads as |
| --- | --- | --- |
| recall@k | `1` if `0 < rank <= k`, else `0` | Was the answer retrieved within the top `k` at all? |
| MRR | `1 / rank`, `0` when absent | How high did it land? Rank 1 scores `1.0`, rank 2 `0.5`, rank 10 `0.1` |

Both are averaged over the rows of a slice, and over every row for the overall figure.

Positions are **raw result positions**: a document occupying several slots costs the slots the caller sees, and a hit is the first slot any chunk of the expected document holds. The `score` field is never read. Its ordering is the contract, its value is not ([Relevance scoring](../modules/knowledge.md#relevance-scoring)), so a metric built on it breaks at the next fusion change.

## Reading the table

- **recall@k cannot gate a change that only demotes.** A relevant result pushed from rank 1 to rank 2 is still retrieved: recall@5 and recall@10 do not move. MRR falls from `1.0` to `0.5` on that row. A ranking change is judged on both; a gate that reads recall alone passes every demotion vacuously.
- **The overall row hides a slice collapse.** On the [baseline](#retrieval-baseline), a 30-day recency half-life moved overall MRR from `0.8303` to `0.6667` while the `entity` slice's recall@10 fell from `1.0000` to `0.1667`. Keep one slice per question type; the overall figure summarises them and never substitutes for them.
- **Never pin the numbers.** They depend on the embedding model. A check that runs on every deploy asserts structure (a metric was produced, a slice did not fall to zero) and a direction against the previous run, not a value.

## What a multiplier costs on fused output

Reciprocal rank fusion scores are compressed. A result contributes `1 / (rrf_k + rank)` per channel, so at `rrf_k = 60` the top ten of one channel span `1/61` = `0.0164` to `1/70` = `0.0143`: the whole top ten sits inside 13% of the top score. Any factor applied after fusion is therefore far stronger than it looks.

| `rrf_k` | Ranks a `×0.87` multiplier costs a rank-1 result |
| --: | --: |
| `60` | 9 |
| `20` | 3 |
| `5` | 0 |

The [recency blend](../modules/knowledge.md#recency-blend) is such a multiplier, `2 ^ (-age_in_days / recency_half_life_days)`; `0.87` is six days of age at a 30-day half-life. A smaller `rrf_k` widens the gaps and buys more room; a larger one less.

### The recency blend is never free

The decay applies to memory results and not to the document chunks they share a result list with, so ageing a fact costs it ground against every chunk as well as against fresher facts. On the [baseline](#retrieval-baseline) corpus, whose memory fixtures carry ages of 3 to 400 days, every half-life from 7 days to 20 years lifts the `freshness` slice's MRR to `1.0`, and every one of them costs the `entity` slice, where the answer is a memory entry competing against undecayed document chunks:

| `KNOWLEDGE_RECENCY_HALF_LIFE_DAYS` | `freshness` MRR | `entity` recall@10 | `entity` MRR | overall MRR |
| --- | --: | --: | --: | --: |
| `0` (off) | 0.6667 | 1.0000 | 0.9583 | 0.8303 |
| `30` | 1.0000 | 0.1667 | 0.1250 | 0.6667 |
| `90` | 1.0000 | 0.4167 | 0.3500 | 0.7158 |
| `365` | 1.0000 | 0.7500 | 0.5097 | 0.7506 |
| `1825` | 1.0000 | 1.0000 | 0.7736 | 0.8082 |
| `7300` | 1.0000 | 1.0000 | 0.9167 | 0.8394 |

The sweep was run in one pass against the golden set as it stood at v3, so its `0` row is that version's overall MRR rather than the current one; the shape of the trade is what it is kept for, not the absolute values.

Pick a half-life from a run against your own corpus, start long, and prefer scoping the search to `memory_store_ids` where freshness is what is actually being ranked.

## Retrieval baseline

SOAT's own ranking changes are gated on a versioned golden set, not on judgement. This is a contributor harness: it needs a repository checkout and a test database, and it is not a way to measure a deployment. For that, follow the [tutorial](/docs/tutorials/measure-retrieval-quality).

`packages/server/tests/eval/knowledge/golden.json` seeds a corpus (module-doc sections, synthetic documents carrying identifiers that occur exactly once, curated memory entries) and scores 55 labeled queries through `searchKnowledge` at `limit: 10`.

```bash
pnpm --filter @soat/server eval:knowledge                    # score and gate
pnpm --filter @soat/server eval:knowledge --update-baseline  # rewrite the baseline
```

Golden set v4:

| Scope         | recall@5 | recall@10 |    MRR |
| ------------- | -------: | --------: | -----: |
| Overall       |   0.8966 |    0.9310 | 0.8138 |
| `exact_token` |   1.0000 |    1.0000 | 1.0000 |
| `exact_name`  |   1.0000 |    1.0000 | 0.9667 |
| `entity`      |   1.0000 |    1.0000 | 0.9583 |
| `freshness`   |   1.0000 |    1.0000 | 0.6667 |
| `semantic`    |   0.6000 |    0.7333 | 0.4802 |

These figures are committed as `baseline.json`, which is the copy to trust: the table above is transcribed from it and a corpus change moves both. The run exits non-zero when **recall@10 or MRR** drops below the committed values, overall or for any single kind; recall@5 is reported, not gated. A ranking change lands with the diff of that file as its before/after table.

The `freshness` kind is the recency blend's own fixture: each query has one answer whose stale near-twin, seeded at a fixture `age_days` in the past, outranks it while the blend is off. Its `0.6667` is the blend-disabled figure this ships with, not a defect.

Both twins sit in **one** memory store, which is what makes the kind a test of ranking rather than of search scope. The corpus store raises its own `supersede_threshold` so they survive the write path together; on the product defaults the older twin would be invalidated on write and never reach the corpus at all. A twin parked in a second store instead measures an unscoped search across a current/archive pair — a configuration `memory_store_ids` already answers, and not one ranking can fix.

Two caveats on the absolute values:

- **The embedder is a stand-in.** CI has no embedding provider, so the eval substitutes a deterministic feature hasher that ranks by term overlap. Being itself lexical, it starts the `exact_token` row saturated: the gate can prove [hybrid retrieval](../modules/knowledge.md#hybrid-retrieval) regresses nothing, but cannot show the lexical channel's win; that proof is a unit test over a chunk whose cosine sits below the floor. What the gate measures reliably is change.
- **The corpus tracks these docs.** Fixtures naming a `source` and a `section` are read from the module docs at seed time, so editing one of those sections moves the numbers. Re-run with `--update-baseline` and commit the diff.
