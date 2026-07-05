# PRD: Deep Thinking — Reasoning Engine & Discussions

> Supersedes the original "Discussions Module" PRD. The multi-agent deliberation idea is re-layered: the **deliberation engine** ships first as invisible machinery behind the existing generate flow (a `reasoning` config — "deep thinking"), and the user-facing **Discussions resource** becomes a later surface on the same engine. The original Discussions design is preserved as Phase 4.
>
> **Direction change (2026-07): thinking moves OUT of agents and INTO the Discussions module — entirely.** The `reasoning` config on agents is removed wholesale, not merely layered under. Rationale: the post-draft model assumes the agent's output is prose worth refining, which breaks for tool-calling agents — thinking runs after all actions are taken, so it can't influence which tools get called, and branch output can only rewrite final text. In the target state, **all thinking is a `Discussion`** — a reusable config whose invocations are `DiscussionRun`s — that an agent invokes *mid-loop* via a tool of type `discussion`, reading the outcome as the tool result. Provider-native effort moves into the module too, as a per-participant/synthesis knob — **accepted trade-off:** ordinary agent generations (including streaming) lose the provider-native thinking knob; an agent that needs to think opens a discussion. **Single-vocabulary rule:** the word `reasoning` disappears from the codebase entirely — API surface *and* internals. The engine is renamed into the discussions lib (`runReasoningPipeline` → `runDiscussion`, branches → participants, `MAX_BRANCHES` → `MAX_PARTICIPANTS`, `reasoning*.ts` → `discussions*.ts`). One concept, one word. See Phase 4 and Phase 5.

## Implementation Status

| Component                                   | Status         | Notes                                                                                          |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Provider-native reasoning passthrough       | ✅ Implemented | `reasoning.effort` (low/medium/high) mapped to OpenAI reasoningEffort, Anthropic thinking budget, Google thinking budget in `reasoning.ts` |
| Shared completion resolver                  | ✅ Implemented | `resolveCompletionModel()` in `completionModel.ts`; used by extraction and reasoning completions |
| `reasoning` config (agent + per-generate)   | ✅ Implemented | `Agent.reasoningConfig` JSONB (`reasoning` on the wire) + per-generate override (object replace) |
| Reflect mode (draft → critique → revise)    | ✅ Implemented | Now expressed as `pipeline` steps — a single-branch critique step with `halt_if_equals` + a revise step (see the schema section); new writes of `mode: "reflect"` are rejected, stored legacy configs are inert (draft + fallback event) |
| Debate mode (homogeneous + heterogeneous)   | ✅ Implemented | Now a multi-branch step whose prompts share turns via `{transcript}`, plus a synthesis step; explicit `branches[]` (1–5; auto-personas removed by the normalization); `rounds` (cap 3); per-branch provider/model; failed branch turns drop (quorum continues); `all_failed`/`output_failed` degrade to draft; new writes of `mode: "debate"` are rejected, stored legacy configs are inert |
| **Reasoning pipeline generalization**       | ✅ Implemented | `mode: "pipeline"` with an ordered list of steps, each the same primitive — `1..N branches × 1..R rounds` (`runReasoningPipeline()` in `reasoningPipeline.ts`); supersedes the discrete `reflect`/`debate` modes **and** the interim `completion`/`fanout` step kinds (normalized away in #390 — `kind`/`count`/`perspectives` are rejected on write). Caps: `MAX_STEPS=8`, `MAX_BRANCHES=5`, `MAX_ROUNDS=3`, `MAX_TOTAL_COMPLETIONS=24`, per-step/pipeline timeouts |
| `applyReasoningPipeline` hook               | ✅ Implemented | Single hook in `reasoningPipelineHook.ts`; wired into `resolveGenerationResult` in `agentNonStreamGeneration.ts` |
| Trace integration                           | ✅ Implemented | Each branch turn recorded as a child generation (shared `traceId`, `initiatorGenerationId`) carrying `metadata.reasoning` `{ step, round, output }` + completion status |
| `metadata.reasoning` telemetry summary      | ✅ Implemented | Parent generation summary `{ mode, applied, reason, stepsRun, dropped, fallback }` — `recordReasoningSummary()` in `reasoning.ts` |
| Silent-degradation event                    | ✅ Implemented | `agents.reasoning.fallback` emitted when a pipeline degrades to the draft (`all_failed`/`output_failed`) and when a stored legacy mode is hit (`fallback`, `data.legacyMode: true`) — `emitReasoningFallbackEvent()` in `reasoning.ts` |
| Async pipeline generate (`?async=true`)     | ❌ Not started | Larger effort; depends on the session async/poll mechanism (deferred)                            |
| `reasoning.budget` guard                    | ❌ Not started | Optional cap on total internal completions per generation (deferred)                            |
| **Discussions module (agent-callable)**     | ❌ Not started | The new home of thinking: a reusable `Discussion` config + `DiscussionRun` instances (list/inspect/retain historical thinking runs). Agents attach a tool of type `discussion` referencing a config and call it mid-loop; the outcome synthesis returns as the tool result. Reuses the (renamed) pipeline engine; participants stay tool-less. See Phase 4. |
| **Remove `reasoning` from agents (entirely)** | ❌ Not started | Once Discussions ships, the whole `reasoning` config is removed from agents: rejected on write, stored legacy configs go inert (draft + `agents.reasoning.fallback` event — same treatment as legacy `reflect`/`debate`). Provider-native `effort` moves into Discussions as a participant/synthesis knob. See Phase 5. |
| Discussions resource module                 | ❌ Not started | Visible transcript, organizer-selected turns, human participants (original PRD, now Phase 4). **Recommendation: build a thin MVP that delegates deliberation to the existing pipeline engine — see Phase 4.** |

## Implementation Phases

### Phase 0 — Provider-Native Reasoning Passthrough ✅ Complete

**Goal:** The cheapest deep thinking is one LLM call with the provider's own reasoning mode turned on. Expose it before building any orchestration.

**Deliverables (as implemented):**

- ✅ `reasoning.effort` (`low` / `medium` / `high`) on the Agent and the generate request body, forwarded via AI SDK `providerOptions` — OpenAI `reasoningEffort`, Anthropic `thinking` budget (4096/16384/32768 tokens, with `maxOutputTokens` raised above the budget), Google `thinkingBudget`; a no-op on providers without a mapping. *(Design deviation: effort lives inside the unified `reasoning` object rather than a separate `reasoning_effort` field — one config, one column, and effort/mode compose.)*
- ✅ OpenAPI + SDK/CLI regeneration, docs, tests

**Unlocks:** Better answers with zero added latency architecture — and a baseline to measure reflect/debate against.

---

### Phase 1 — Reflect Mode ✅ Complete

> **Historical record.** The discrete implementation described below (`maybeApplyReflectionToResult`, the `critique` override block, `mode: "reflect"`) was later normalized away: reflect is now expressed as pipeline steps (see the schema section) and new writes of `mode: "reflect"` are rejected. The deliverables record what shipped in this phase.

**Goal:** Draft → self-critique → revise. One agent, no personas, roughly 3 LLM calls. The biggest quality-per-dollar step after Phase 0.

**Deliverables (as implemented):**

- ✅ `reasoningConfig` JSONB on Agent (mirrors `knowledgeConfig`); per-generate `reasoning` body field replaces it (object replace, not merge)
- ✅ Reflect flow inside the generation pipeline (`maybeApplyReflectionToResult` hooked before the completion result is built, so the trace, completion event, and API response all carry the final text): draft → critique → revise, with an APPROVED short-circuit that skips the revision call when the critique finds nothing to improve
- ✅ **`critique` override block** `{ ai_provider_id?, model?, prompt? }` — same triple, resolution, and project-scope validation as `knowledge_config.extraction`, via the shared `resolveCompletionModel()`
- ✅ Critique/revision calls are plain completions (no tools); the outcome is recorded on the generation record's `metadata.reasoning` (`{ mode, applied, reason }`)
- ✅ Tests: pipeline wiring (providerOptions forwarding, text replacement, fallback), reflect orchestration (override routing, APPROVED, failure degradation), real-execution completion boundary, REST config round-trip
- **Scope notes:** reflect applies to non-streaming completed generations; streaming and `requires_action` (client-tool) continuations are skipped. When reflection rewrites the text, the draft's `responseMessages` are dropped so conversation replay does not resurrect the draft.

**Unlocks:** "Think before you answer" on any existing agent with one config field.

---

### Phase 2 — Debate Mode ✅ Complete

> **Historical record.** This phase's vocabulary (`mode: "debate"`, `perspectives`, `max_rounds`, a `synthesis` block) shipped and was then normalized into the `branches × rounds` primitive — see the evolution callout at the end of this phase. The deliverables below record the original design.

**Goal:** Internal multi-perspective deliberation behind a single generate call. This is the deliberation engine — built as an internal library, not a REST resource.

**Deliverables:**

- `mode: "debate"` with:
  - **`perspectives`** — an integer (auto-generated personas: advocate / skeptic / pragmatist, on the agent's own provider/model) **or** an array of perspective objects:
    `{ name?, prompt?, ai_provider_id?, model? }` — each perspective may run on a **different provider and model with its own prompt**. Defaults per field fall back to the agent. 2–5 perspectives.
  - **`max_rounds`** — hard cap (default 1, max 3). One round is often enough: independent takes + synthesis ≈ self-consistency; additional rounds let perspectives rebut each other
  - **`synthesis`** — `{ ai_provider_id?, model?, prompt? }` override for the final pass that weighs the debate and produces the single answer (defaults to the agent itself)
- Engine (`src/lib/deliberation.ts` or similar): round-robin turns over an in-memory transcript; every perspective sees the question and all prior turns attributed by perspective name; perspective calls are plain completions (no tools — only the final synthesis-bearing agent context owns side effects)
- The response remains a normal `GenerationResult`; callers don't change. The full deliberation is visible in the trace, each step tagged with perspective name and model
- **No new resources**: no Conversation, no Actors — the transcript is engine state persisted only into the trace
- Failure semantics: a failing perspective is dropped and noted in the trace (quorum continues); if all perspectives fail or synthesis fails, fall back to a plain single-pass generation rather than failing the request — deep thinking must never make an agent *less* reliable
- Tests: homogeneous debate, heterogeneous routing (per-perspective provider/model asserted via completion-boundary spy), perspective-failure degradation, full-failure fallback, max_rounds enforcement

**Why heterogeneous matters:** perspectives from one model correlate — same weights, same blind spots, polite self-agreement. Different model families disagree more substantively, and that disagreement is the signal synthesis harvests. It also shapes cost: cheap fast models debate, a flagship model synthesizes (or the inverse).

**Unlocks:** "Deep thinking" as a per-agent or per-request knob; the engine that Phase 4 later exposes as a product.

> **Post-PRD evolution — pipeline generalization + branches/rounds normalization (implemented).**
> Reflect and debate first converged into a single configurable **reasoning pipeline**
> (`mode: "pipeline"` runs an ordered list of steps), and a follow-up breaking change (#390)
> then normalized the steps themselves: there are **no step kinds**. Every step is the same
> primitive — **`1..N branches × 1..R rounds`** — and visibility/reduction is expressed through
> prompt **template tokens** (`{question}`, `{draft}`, `{steps.<name>}`, `{steps.<name>.last}`,
> `{transcript}`), not fields: a single-branch single-round step is the old "completion"
> (critique, revise, synthesize); a multi-branch step whose prompts reference `{transcript}` is
> the old "debate" fanout (turns shared round-robin); a multi-branch step without `{transcript}`
> is independent best-of-N sampling. The interim `kind`/`count`/`perspectives` step fields are
> **rejected on write** ("was removed; express it with 'branches' instead"), as are new writes
> of the discrete `mode: "reflect"` / `mode: "debate"` — agents still storing a legacy mode are
> **inert** (they return the plain draft and emit `agents.reasoning.fallback`). The engine lives
> in `reasoningPipeline.ts` (`runReasoningPipeline`), is validated by `validateReasoningConfig`
> in `reasoningValidation.ts` (re-exported from `reasoning.ts`), and is hooked via
> `applyReasoningPipeline` in `reasoningPipelineHook.ts`. **Phase 4 layers on this normalized
> engine — participants map to a step's `branches`.**

---

### Phase 3 — Observability & Async 🟡 Observability slice complete; async/budget deferred

**Goal:** Deliberation is slow (N×M calls); make it watchable and non-blocking.

**Deliverables:**

- ✅ **Trace integration** — each branch turn is recorded as a child generation sharing the parent's `traceId` and linked via `initiatorGenerationId`, carrying `metadata.reasoning` `{ step, round, output }` (step/branch name) and a completion status (`completed`/`failed`). Grouped per round via the `round` field.
- ✅ **`metadata.reasoning` summary** on the parent generation record (same pattern as `metadata.extraction`): `{ mode, applied, reason, stepsRun, dropped, fallback }` — `fallback` is derived from the outcome reason so an intentional `halt_if_equals` short-circuit is never mislabelled as degradation.
- ✅ **Webhook/event on deliberation fallback** — `agents.reasoning.fallback` is emitted whenever the engine silently degrades to the plain draft (`all_failed` / `output_failed`, plus `fallback` with `legacyMode: true` for stored legacy modes), so silent degradation is detectable. Payload: `{ mode, reason, stepsRun, dropped }`.
- ❌ **Async generate** (`?async=true` parity with sessions) returning `in_progress` + poll, for pipeline generations — deferred (larger; depends on the session async mechanism).
- ❌ Optional **`reasoning.budget` guard** (max total completions per generation) — deferred.

**Unlocks:** The deliberation engine's cost and health are now measurable per generation, and silent fallbacks surface on webhooks instead of being invisible.

---

### Phase 4 — Discussions Resource (the new home of thinking) ❌ Not started · **Recommendation: thin MVP**

**Goal:** Make orchestrated thinking a first-class resource instead of an invisible post-draft phase on agents. A `Discussion` is a durable, listable thinking run — usable standalone (brainstorming, red-teaming, expert review, where the transcript is the deliverable) **and** as the way an agent thinks mid-loop (via the auto-derived `create-discussion` SOAT action). Layered on the pipeline engine (Phase 2 + the pipeline generalization above); Phase 5 then removes the agent-side pipeline this module replaces.

#### Should we build it? — Recommendation

The pipeline engine already delivers the *answer-quality* value of "multiple agents reasoning together" (multi-branch deliberation + synthesis, behind one `generate` call, observable in traces). **A Discussions resource is worth building when one of two bars is met** — both being things the invisible engine deliberately refuses to do:

1. **The transcript itself is the deliverable** — a **persistent, attributed, inspectable transcript** (brainstorming, red-teaming, expert review). For pure answer quality alone, prefer a `reasoning` pipeline; do not stand up a resource.
2. **An agent needs to invoke deliberation mid-loop and the run must be a durable, listable object.** This is the "redefine the thinking part of agents" driver: a tool-calling agent has no natural post-draft answer to refine, so reasoning must be something it *calls* and gets a result back from — and the project wants to list and inspect those runs historically, not just dig through per-execution traces. A resource satisfies both: its `POST /discussions` auto-derives a `create-discussion` SOAT action (the agent trigger + result return), and the row is first-class listable/permissioned/retained.

**Naming decision — `discussions` (final; chosen for marketing and long term).** Considered: `reasoning`, `deep-thinking`, `deliberations`, `discussions`. `reasoning` is the most crowded word in AI — every provider markets "reasoning models," so a SOAT `reasoning` module would read as a wrapper around provider-native thinking rather than orchestrated deliberation, and it is un-ownable in positioning and search; it is also mechanism-named with awkward resource grammar (`POST /reasonings`, "a reasoning"). `deep-thinking` is the marketing *umbrella term* for the capability, not a countable resource — it stays in prose and landing copy. `deliberations` duplicates the meaning of `discussions` in a stiffer word while abandoning the vocabulary this PRD's roadmap is written in. `discussions` names the object (topic + participants + transcript + outcome *is* a discussion), has natural REST grammar and the best agent-tool ergonomics (`create-discussion` reads exactly right to a model choosing tools mid-loop), and carries the ownable long-term story — *agents convene a panel to think before they act; later, humans join the discussion* — through human participants, organizer-selected turns, and expert-in-the-loop without a rename. **Single-vocabulary rule (final):** `discussion` is the only name, in the API *and* the codebase. No `reasoning` vocabulary survives Phase 5 — engine files, functions, constants, and types all rename into the discussions lib (`reasoning.ts`/`reasoningPipeline.ts`/`reasoningCompletion.ts`/`reasoningValidation.ts` → `discussions*.ts`, `runReasoningPipeline` → `runDiscussion`, `ReasoningStep`/`ReasoningBranch` → `DiscussionStep`/`DiscussionParticipant`, `MAX_BRANCHES` → `MAX_PARTICIPANTS`, `metadata.reasoning` → `metadata.discussion`). "Deep thinking" remains permissible as a docs/marketing umbrella phrase only.

**Prompt composition decision — template strings, not JSON Logic (final).** Considered for step/participant prompts: the engine's `{token}` templates vs the JSON Logic the project already uses everywhere else (orchestration `inputMapping` and edge conditions, pipeline-tool mappings, tool `output_mapping`, ingestion-rule converters). Decision: prompts stay **template strings**. The rule, consistent with the rest of the codebase: *prose the model reads is a template; data the machine routes is JSON Logic* — every existing JSON Logic use is structured data plumbing (`var` selects fields, `cat` builds machine-facing values like `data:` URIs), never model-facing prose. Rationale: prompts are the bulk of a discussion config and must stay readable and diffable to the humans *and agents* that author them (a persona prompt shredded into `cat` array elements is neither); the closed token grammar is what makes the write-time guarantees possible — referential integrity of `{steps.<name>}`, the `.last` restriction, and `{transcript}`-presence switching a step between shared round-robin and independent sampling — an open expression language would have to be statically restricted back down to exactly this to keep them; and logic inside prompt assembly would erode the module's boundary (a pipeline is pure meta-cognition, never a workflow engine) — conditional composition belongs to orchestrations, which already speak JSON Logic and can invoke a discussion. JSON Logic still meets the module at two seams: the `discussion` tool's result is reshapeable today via the tools layer's existing `output_mapping` (nothing to build), and if halt conditions ever outgrow `halt_if_equals`, the extension is a JSON Logic `halt_when` predicate over `{ output }` — a predicate, not prose. Accepted caveat: the `{token}` grammar has no escape (a literal `{draft}` inside prompt text is substituted; unknown tokens pass through untouched) — if that ever bites, add `{{token}}` escaping rather than switching languages.

**Why a resource and not a bare tool or a trace query-view.** The engine already records every reasoning run as child generations under a shared `trace_id` (`GET /generations?trace_id=…`), so a thin query-view over traces *could* deliver listing. But a `Discussion` needs what trace telemetry cannot give: its own permissions (`discussions:Create/Read`), a stable public id to reference/re-open, retention independent of trace lifecycle, a **formation** resource type (declare a discussion in infra-as-code), and an outcome Document. Traces are execution telemetry; a Discussion is a domain object. Build the resource; the trace tree remains underneath for per-turn observability.

When that bar is met, build a **thin MVP** that *delegates deliberation to the existing pipeline engine* rather than re-implementing debate. Recommended scope:

| Decision | Recommendation | Rationale |
| --- | --- | --- |
| Build the resource? | Yes — thin MVP only | Persistent attributed transcript **and** an agent-callable, listable thinking run are the capabilities the engine lacks |
| Re-implement deliberation? | **No** — reuse `runReasoningPipeline` | The `branches × rounds` primitive already does multi-perspective turns + rounds + synthesis + traces |
| Agent trigger (MVP) | **Yes — a tool of type `discussion`** | `{ type: "discussion", discussion_id }` attached via `tool_ids`, dispatched in `toolsCall.ts` (same pattern as the `mcp` type); the agent calls it mid-loop with a `topic` and reads the outcome as the tool result. This is the answer to "how do participants return to the main agent" and "when does a tool-only agent call them" |
| Participant identity (MVP) | **Engine branches (tool-less)** | Maximizes reuse; sidesteps the tools-per-turn decision; leaves a clean seam to real Agents |
| Lifecycle (MVP) | **Synchronous** `pending → running → completed/failed` | Defer async/poll until the session async mechanism (Phase 3) lands. Note: a synchronous `discussion` tool call blocks the calling agent for the full N×M run — bounded by engine caps + timeouts, same profile as a nested `create-agent-generation`; async is the deferred upgrade |
| Turn policy (MVP) | `round_robin` only | `organizer_selects` needs the organizer decision protocol — defer |
| Human-in-the-loop (MVP) | Deferred | Reuses orchestration `requires_action` later; not MVP |

#### Thin MVP design

- **Config vs run — same split as Agent → Generation.** A `Discussion` is a **reusable configuration** (who deliberates and how); each invocation creates a **`DiscussionRun`** (what was deliberated and what came out). Users author configs once; agents and callers invoke them many times.
- **`Discussion` (`disc_`) — the config**: `project_id`, `name`, `description`, `max_rounds` (cap 3), `ai_provider_id` (**required** — the project-scoped default provider participants and synthesis fall back to; a standalone discussion has no agent to inherit from), `synthesis` override triple, `tags`, plus its participants.
- **`DiscussionRun` (`drn_`) — the instance**: `discussion_id`, `topic` (the invocation argument), `status` (`pending|running|completed|failed`), `conversation_id` (the persisted transcript), `outcome_document_id` (the stored synthesis), `started_by`, `initiator_generation_id` (set when an agent invoked it mid-loop), `trace_id`. The synchronous run response inlines the `outcome` text so a tool result carries it directly (no follow-up read required); the Document is the durable copy. `GET /discussions/:id/runs` lists a config's history.
- **Synthesis semantics — outcome always exists, config optional.** The outcome is the tool-result contract, so a completed discussion always has one; but the `synthesis` block is never required. Defaults: multi-participant or multi-round discussions run a synthesis pass (built-in prompt, discussion-level provider/model, overridable via the `{ai_provider_id?, model?, prompt?}` triple per the shared override contract); a single-participant single-round discussion's lone turn *is* the outcome — no extra completion unless `synthesis` is explicitly configured (mirrors the engine's output-defaults-to-last-step rule). Synthesis failure keeps the existing degradation stance: fall back to the last successful turn as the outcome rather than failing the run. Transcript-only discussions (explicit synthesis opt-out, no outcome) are deferred — they'd break the tool-result contract and only serve the human transcript-is-the-deliverable case.
- **`DiscussionParticipant` (`dpt_`)**: `discussion_id`, `actor_id`, `prompt` (persona), `position`, plus per-participant `ai_provider_id?` / `model?` / `temperature?` / `effort?` (provider-native thinking budget — relocated here from the agent's removed `reasoning.effort`; also accepted on the `synthesis` triple).
- **Transcript reuse** — persisted as a real [Conversation](../packages/website/docs/modules/conversations.md) with [Actor](../packages/website/docs/modules/actors.md) authorship (`addConversationMessage`), one Actor per participant; outcome stored as a Document. **No new transcript machinery.**
- **`runDiscussion`** maps participants → a debate-shaped step's `branches` (prompts sharing turns via `{transcript}`), calls `runReasoningPipeline` (models resolved via `resolveCompletionModel`), then **persists each turn attributed to its Actor** and the synthesis as the outcome Document. Failure degrades gracefully (deep thinking must never make the resource *less* reliable).
- **Agent trigger — a tool of type `discussion`.** The canonical way an agent thinks is a tool referencing a discussion config — `{ type: "discussion", name, description, discussion_id }` — attached via `tool_ids` like any other tool and dispatched by a new `discussion` case in `toolsCall.ts` (exact precedent: the `mcp` type references an MCP server config). The tool's input schema is `{ topic }` (plus optional context); calling it creates a `DiscussionRun` **synchronously** and returns the outcome + run id as the tool result. Chosen over an agent-level `allow_discussion: <id>` arg because the model invokes *tools*, not agent fields — an agent arg would still need a synthetic tool surface, while the tool type inherits `tool_choice` / `step_rules` / `active_tools` for free and lets one agent carry several named thinking styles (`red-team-decision`, `brainstorm-angles`), each self-describing so the model knows which to reach for. The generic auto-derived SOAT actions (`create-discussion-run`, etc.) still exist for API/platform access, but the tool type is the designed agent path. This is how the resource closes the original "redefine thinking" gap:
  - **Return to the main agent** = the tool result carries the **outcome synthesis + the run id — never the full transcript**. The result re-enters the caller's message history on every subsequent step, so returning the N×M transcript would flood the caller's context and defeat the reduction the pipeline exists to do. Both artifacts persist on the resource (transcript = Conversation, outcome = Document); the agent drills into the transcript on demand via a follow-up `get-discussion-run` / conversation read when the synthesis warrants it. Dissent that must survive reduction is a synthesis-prompt authoring concern ("state the recommendation and the strongest objection"), not a payload one.
  - **When the agent calls it** = whenever the model selects the `discussion` tool; `tool_choice: required` or a `step_rules` pin forces "discuss before acting."
  - **History** = every call is a first-class `DiscussionRun` row: `GET /discussions` lists the configs, `GET /discussions/:id/runs` lists a config's run history, and each run links its transcript Conversation + outcome Document.
- Full module surface per `.claude/rules/modules.md`: REST + OpenAPI, permissions, formation module + `DiscussionResourceProperties`, SDK/CLI regen (MCP auto-derived), docs, tests (TDD), smoke steps.

#### Deferred to a later Discussions phase (clean seams kept)

- **Async run** (`?async=true`, `in_progress` + poll) — depends on the session async mechanism (Phase 3 deferred item).
- **Human participants** via `paused` + `required_action`, mirroring `executeHumanNode` in `orchestrationNodeExecutors.ts`.
- **`organizer_selects` turn policy** + organizer decision protocol (continue/end, next speaker) — prompt-based JSON with lenient parsing.
- **Real Agents with tools as participants** — the resource surface likely wants real Agents; the engine deliberately avoids tools. The Actor→participant seam makes this a later swap.
- **Orchestration `discussion` node type**; webhooks; cancellation/pause lifecycle states.

> Original Phase 4 design (organizer agent, full async-first lifecycle, human-in-the-loop, formation, orchestration node) is preserved in the git history of this file and folded into the "deferred" list above.

---

### Phase 5 — Remove Thinking from Agents ❌ Not started · depends on Phase 4

**Goal:** One home for thinking. After Discussions ships, the `reasoning` config is removed from agents **entirely** — pipeline *and* provider-native effort. The module is not a second way to think, it is *the* way: an agent that needs to think opens a discussion.

**What stays on agents:** nothing. Provider-native effort (OpenAI reasoningEffort / Anthropic thinking budget / Google thinkingBudget) moves into Discussions as a per-participant/synthesis knob (`effort` on the participant and `synthesis` triples), where it tunes the deliberation completions. **Accepted trade-off:** ordinary agent generations — including streaming — lose the provider-native thinking knob; models that reason by default still do, but SOAT no longer exposes a budget dial on the agent itself.

**Deliverables:**

- **Write-time rejection** — the `reasoning` field on agent create/update and on the per-generate override is rejected with `INVALID_REASONING_CONFIG`, pointing at Discussions (a `discussion`-type tool) as the replacement. The field, the `reasoningConfig` column read path, and the OpenAPI `ReasoningConfig` schema are removed.
- **Effort relocation** — `buildReasoningProviderOptions` stops being wired into agent generation and is invoked by the Discussions engine for participant/synthesis completions that set `effort`.
- **Stored legacy configs go inert** — an agent still carrying `mode: pipeline` behaves exactly like the removed `reflect`/`debate` modes today: the generation returns the plain draft and emits `agents.reasoning.fallback` (`data: { legacyMode: true }`) so the migration gap is visible. No hard failure — deep thinking must never make an agent less reliable, including during its own removal.
- **Migration guide** — docs mapping each pipeline recipe to its Discussion equivalent (post-draft reflect/debate/best-of-N → a `Discussion` with the same steps, invoked by the agent or by the caller before/after generate) and `reasoning.effort` to participant/synthesis `effort`. No automated data migration: the `reasoningConfig` JSONB column simply stops being read.
- **Cleanup — the single-vocabulary rename** — `applyReasoningPipeline` hook removed from `resolveGenerationResult`; the engine survives but is renamed into the discussions lib per the single-vocabulary rule (`reasoning*.ts` → `discussions*.ts`, `runReasoningPipeline` → `runDiscussion`, `ReasoningStep`/`ReasoningBranch` → `DiscussionStep`/`DiscussionParticipant`, `MAX_BRANCHES` → `MAX_PARTICIPANTS`, `metadata.reasoning` → `metadata.discussion`, `agents.reasoning.fallback` event retired with the agent surface); `agents.md` "Reasoning (Deep Thinking)" section is replaced by a pointer to Discussions; OpenAPI `ReasoningConfig` removed (SDK/CLI regen); tests updated. After this phase, `grep -ri reasoning packages/server/src` returns nothing.

**Sequencing note:** the removal is a **breaking change** to the agent API surface (`ReasoningConfig` shrinks), so it rides a major version per the release rules, with at least one release where `mode: pipeline` still runs but logs/emits a deprecation signal before going inert.

---

## Override Semantics

All provider/model/prompt overrides in this PRD — every pipeline step, every `branches[]` entry, and Phase 4's participant/`synthesis` triples — use the **same contract established by `knowledge_config.extraction`**:

| Field            | Default                | Rule                                                                                       |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `ai_provider_id` | agent's provider       | Must belong to the agent's project (validated at call time; prevents borrowing another project's secret) |
| `model`          | chain below            | `model` → override provider's `default_model` (when `ai_provider_id` set) → agent's `model` → agent provider's `default_model` |
| `prompt`         | step/branch template   | A branch prompt falls back to its step's. Prompts are full templates — context enters via explicit tokens (`{question}`, `{draft}`, `{steps.<name>}`, `{steps.<name>.last}`, `{transcript}`); nothing is auto-appended. Phase 4's synthesis keeps a built-in default prompt |

**Shared implementation (done):** `resolveCompletionModel({ agentId, projectIds, aiProviderId?, model? })` in `completionModel.ts` is the single source of truth for the resolution + project-scope security check, used by memory extraction and every reasoning completion (each step/branch turn). Phase 4's `runDiscussion` reuses it unchanged.

## Reasoning Config Schema

> **Target end-state (Phase 5):** this schema is removed from agents entirely — pipeline `mode`/`steps` **and** `effort`. The step model carries over as the Discussion run definition, and `effort` becomes a per-participant/synthesis knob there. Everything below describes the shipped-but-to-be-removed agent surface.

Stored as `reasoningConfig` JSONB on the `agents` table; per-generate `reasoning` body field overrides it (object replace, not deep merge). All snake_case on the wire per case convention.

The shipped engine uses **`mode: "pipeline"`** with an ordered list of `steps`, where every step is the **same primitive — `1..N branches × 1..R rounds`** — with no preset kind: a single-branch single-round step is a plain completion (critique, revise, synthesize); a multi-branch step whose prompts reference `{transcript}` is a debate (turns shared round-robin); a multi-branch step without `{transcript}` is independent best-of-N sampling. `effort` composes with any mode. The pipeline runs after the base draft and applies to non-streaming completed generations only. New writes of the legacy `mode: "reflect"` / `mode: "debate"` — and of the interim `kind` / `count` / `perspectives` step fields — are **rejected** with `INVALID_REASONING_CONFIG`; agents still storing a legacy mode are **inert** (they return the plain draft and fire `agents.reasoning.fallback`).

```jsonc
// Provider-native reasoning only — no orchestration
{ "reasoning": { "effort": "high" } }

// Reflect — critique (halt when approved) → revise
{
  "reasoning": {
    "mode": "pipeline",
    "steps": [
      { "name": "critique", "prompt": "Critique this draft; list concrete improvements or reply exactly APPROVED:\n{draft}", "halt_if_equals": "APPROVED" },
      { "name": "revise", "prompt": "Revise the draft using the critique.\nDraft:\n{draft}\nCritique:\n{steps.critique}", "output": true }
    ]
  }
}

// Debate — heterogeneous branches sharing a transcript over 2 rounds → synthesis
{
  "reasoning": {
    "mode": "pipeline",
    "steps": [
      {
        "name": "debate",
        "rounds": 2,
        "prompt": "Take your angle on: {question}\n{transcript}",
        "branches": [
          { "name": "Skeptic", "prompt": "Attack the strongest claim and surface hidden assumptions on: {question}\n{transcript}", "ai_provider_id": "aip_anthropic", "model": "claude-sonnet-4-6" },
          { "name": "Advocate", "prompt": "Steelman the proposal with concrete evidence on: {question}\n{transcript}", "model": "gpt-4o-mini" },
          { "name": "Pragmatist" }
        ]
      },
      {
        "name": "synthesis", "output": true,
        "ai_provider_id": "aip_flagship",
        "prompt": "Weigh the arguments; commit to a single recommendation with rationale:\n{steps.debate}"
      }
    ]
  }
}
```

| Field          | Type                | Default  | Notes                                                                                  |
| -------------- | ------------------- | -------- | -------------------------------------------------------------------------------------- |
| `effort`       | string              | —        | `low` \| `medium` \| `high` — provider-native reasoning; composes with `mode`           |
| `mode`         | string              | `"none"` | `none` \| `pipeline` (legacy `reflect` / `debate`: rejected on write, inert when still stored) |
| `steps`        | object[]            | —        | Pipeline only — ordered steps, each `1..N branches × 1..R rounds` (`MAX_STEPS=8`)       |
| `budget`       | integer             | —        | Deferred (❌ not started) — a fixed `MAX_TOTAL_COMPLETIONS=24` engine cap (Σ branches × rounds) applies today |

**Step fields:** `name` (unique, no `.`), `prompt` (template; required unless every branch supplies its own), `branches?` (`{ name?, prompt?, ai_provider_id?, model?, temperature? }`, 1–5; omit for a single implicit branch), `rounds?` (default 1, cap 3; `rounds > 1` requires a `{transcript}` reference), step-level `ai_provider_id?` / `model?` / `temperature?` defaults for branches that omit their own, `output?` (this step's text becomes the answer; defaults to the last step), `halt_if_equals?` (single-branch steps only — halt the pipeline and keep the draft).

**Template tokens:** `{question}` (the flattened conversation), `{draft}` (the agent's initial answer), `{steps.<name>}` (an earlier step's full output), `{steps.<name>.last}` (only its final turn — rejected against an independent multi-branch step, whose last turn is an arbitrary sample), `{transcript}` (prior turns within the current step — its presence is what switches branches from independent samples to a shared round-robin debate). A reference to an unknown or later step is rejected at write time rather than silently resolving to an empty string.

## Relationship to Other Modules

| Concern                       | Owner                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| Provider/model resolution     | Shared completion resolver (also used by memory extraction)             |
| Deliberation transcript (P2)  | Engine state → trace steps only                                         |
| Deliberation transcript (P4)  | Conversations (+ Actors for authorship)                                 |
| Observability                 | Traces + `metadata.reasoning` on the generation record                  |
| Cost controls                 | Per-step `rounds`/`branches` caps, `MAX_TOTAL_COMPLETIONS`, step/pipeline timeouts (deferred: `budget`) |

## Open Questions

1. **Auto-escalation** — should a cheap triage step decide *when* to debate ("is this question contested/hard?") instead of a static config? Proposal: defer; per-request override covers it manually.
2. **Knowledge injection in branches** — do branch turns get the agent's `knowledge_config` context? Proposal: yes for the question context (it's the same question), but no self-retrieval tools.
3. **Streaming** — a pipeline can't stream the final answer until the output step; stream output-step tokens only, or emit per-round trace events? Proposal: Phase 3 decision.
4. **Reflect + debate composition** — ~~allow synthesis output to be reflected on?~~ **Resolved** by the pipeline generalization: both compose as `steps`, so a multi-branch debate step + synthesis can be followed by critique/revise steps in one pipeline.
