# QA checklist — memories

Covers memory containers, the entry write algorithm, merge consolidation, the
agent write path, and auto-extraction. Retrieval over memories is in
[`knowledge.md`](./knowledge.md) — the two were validated in one pass
([#348](https://github.com/ttoss/soat/issues/348)) and are split here to match
the module boundary.

Module docs: [`packages/website/docs/modules/memories.md`](../../packages/website/docs/modules/memories.md)
Related PRD: [`docs/prd-memories.md`](../prd-memories.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-03 | `soat-tests` MCP project-key credential, project `proj_ElQRuVqixOmM9Qva`, AI provider `bedrock` / `deepseek.v3.2` — three runs | all in-scope reachable items pass | [#355](https://github.com/ttoss/soat/issues/355), [#357](https://github.com/ttoss/soat/issues/357), [#358](https://github.com/ttoss/soat/issues/358), [#359](https://github.com/ttoss/soat/issues/359), [#371](https://github.com/ttoss/soat/issues/371) — all fixed and verified ([#348](https://github.com/ttoss/soat/issues/348)) |

Run 1 found #355/#357/#358/#359. Run 2 confirmed three of them fixed and found
#371 (a distinct bug still blocking self-retrieval behind the partial #358 fix).
Run 3 confirmed #371 fixed.

LLM output is nondeterministic — these items assert structure and behavior
(status codes, `action` values, entry counts, `source_type`), never generated
text.

## Memory container CRUD

- [x] `POST /memories` → created, `id` starts `mem_`, fields echo
- [x] `GET /memories/{id}` (was `403` for the creator under [#355](https://github.com/ttoss/soat/issues/355))
- [x] `GET /memories?project_id=` → `200`, array includes the memory
- [x] Tag glob filter (`tags=cr*` includes, `tags=nope*` excludes) — both directions
- [x] `PUT /memories/{id}` (was #355)
- [x] `DELETE /memories/{id}` (was #355); re-`GET` returns not-found

## Write algorithm — manual REST writes concatenate

- [x] First write → `action: "created"`
- [x] Near-identical write → `action: "skipped"`, same entry id
- [x] Related write → `action: "updated"`, content **concatenated** with `\n`
- [x] Unrelated write → `action: "created"`, new entry id
- [x] Threshold override forcing `action: "updated"`
- [x] `GET` / `PUT` / `DELETE` a single entry — all three succeed
- [x] Unknown `memory_id` → not-found

## Merge consolidation on agent paths

- [x] An agent with `write_memory_id`, told to record two overlapping/contradictory facts (phone → email), **collapses to a single coherent entry** — same `entry_id` both times, not a concatenation blob, contradiction resolved toward the newer fact
- [x] Contrast confirmed: a manual REST write to a separate memory concatenates, proving the agent path is doing something different by design
- [ ] LLM-unavailable fallback — *not covered, infeasible to simulate live*

Manual-write consolidation is **out of scope by design**: manual writes
concatenate for now.

## Agent write path

- [x] Agent write via the `write_memory` tool persists a new entry with the correct content, confirmed via direct `GET`

## Auto-extraction (post-conversation)

- [x] `metadata.extraction` exposed on `GET /agents/{id}/generate/{gen_id}`, counts sanity-checked against ground truth (was stored but never exposed, [#359](https://github.com/ttoss/soat/issues/359))
- [x] Object form `extraction: {model, prompt}` round-trips and runs with the override
- [x] Opt-in only — no `extraction` flag means no entry written

## MCP tool-surface parity

- [x] `tools/list` includes the memory tools
- [x] `tools/call write-memory-entry` creates an entry visible via REST (was #355)

## Not covered

- [ ] **AuthN / AuthZ (`401` / `403`)** — the MCP interface used for this pass always authenticates with a fixed credential, so neither could be driven. Cover these via REST with a purpose-built no-permission principal on the next pass.
- [ ] **Temporal invalidation / supersede** (`invalidated_at`, `superseded_by_entry_id`) — unimplemented at the time of the pass.
- [ ] **Entry provenance** (`source_generation_id`, `source_conversation_id`) — unimplemented at the time of the pass.
- [ ] **Entity graph** (entities, edges, `entity_ids` / `actor_ids` / `predicate` queries) — unimplemented at the time of the pass.
- [ ] **Streaming and `requires_action` extraction coverage** — unimplemented at the time of the pass.

The four "unimplemented at the time of the pass" items are from the 2026-07-03
scope statement. Re-check whether they have shipped before the next pass.
