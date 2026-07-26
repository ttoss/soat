# QA checklist — knowledge

Covers unified search across documents and memories, the agent read path
(`knowledge_config` auto-injection), injection hardening, and self-retrieval.
Memory containers and the entry write algorithm are in
[`memories.md`](./memories.md) — the two were validated in one pass
([#348](https://github.com/ttoss/soat/issues/348)) and are split here to match
the module boundary.

Module docs: [`packages/website/docs/modules/knowledge.md`](../../packages/website/docs/modules/knowledge.md)
Related PRD: [`docs/prd-knowledge.md`](../prd-knowledge.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-03 | `soat-tests` MCP project-key credential, project `proj_ElQRuVqixOmM9Qva`, `bedrock` / `deepseek.v3.2`, real embedding provider — three runs | all in-scope reachable items pass | [#357](https://github.com/ttoss/soat/issues/357), [#358](https://github.com/ttoss/soat/issues/358), [#371](https://github.com/ttoss/soat/issues/371) — all fixed and verified ([#348](https://github.com/ttoss/soat/issues/348)) |

Semantic recall needs real embeddings — a pass against a server without a working
embedding provider proves nothing here.

## Search — documents

- [x] Document under `/sales/policy.md`; `search-knowledge` with `document_paths` → `source_type: "document"`, `chunk_id` present
- [x] `document_ids` filter scopes to that document
- [x] `min_score` and `limit` both behave

## Search — memories and mixed

- [x] `memory_ids` scoping
- [x] `memory_tags` glob
- [x] `memory_ids` + `memory_tags` together → confirmed **union**, not intersection
- [x] No source filters → project-wide search works
- [x] Mixed document + memory results, descending `score`

## Agent read path & injection hardening

- [x] Recall works — the agent answered from the consolidated memory fact
- [x] Per-generation `knowledge_config` merge → confirmed union of stored + per-call config (the override did not exist before [#357](https://github.com/ttoss/soat/issues/357))
- [x] **Injection hardening (adversarial):** a memory entry seeded with a prompt-injection payload was ignored; the agent answered the real question correctly. Retrieved knowledge is injected as delimited, non-system reference content
- [ ] The raw input-message role is not independently observable through the API — *not covered by black-box testing*. Source review confirms `role: "user"`, consistent with the adversarial item passing

## Self-retrieval tool

- [x] Self-retrieval via a `search-knowledge` tool mid-turn: the model made a real structured tool call, got results back, and produced a correct synthesized answer citing both a memory and a document — clean 2-step trajectory, `stop_reason: "stop"`, ~5s (was blocked by [#358](https://github.com/ttoss/soat/issues/358), then by [#371](https://github.com/ttoss/soat/issues/371) after #358's partial fix)

An earlier attempt against an agent configured with `tool_choice: "required"` and
no exit condition ran ~2.6 minutes and exhausted `max_steps` forcing repeated tool
calls every step. That was a **test-configuration artifact**, not a platform bug —
the server handled it gracefully to a `completed` status throughout.

## MCP tool-surface parity

- [x] `tools/list` includes the knowledge tools
- [x] `tools/call search-knowledge` matches REST semantics with camelCase fields

## Not covered

- [ ] **AuthN / AuthZ (`401` / `403`)** — the MCP interface used for this pass always authenticates with a fixed credential. Cover via REST with a purpose-built no-permission principal on the next pass.
- [ ] **Hybrid lexical+vector search, RRF fusion, rerank, recency weighting** — unimplemented at the time of the pass; re-check before the next one.
