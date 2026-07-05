# PRD: Deep Thinking — Reasoning Engine & Discussions

> Supersedes the original "Discussions Module" PRD. The multi-agent deliberation idea is re-layered: the **deliberation engine** ships first as invisible machinery behind the existing generate flow (a `reasoning` config — "deep thinking"), and the user-facing **Discussions resource** becomes a later surface on the same engine. The original Discussions design is preserved as Phase 4.

## Implementation Status

| Component                                   | Status         | Notes                                                                                          |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Provider-native reasoning passthrough       | ✅ Implemented | `reasoning.effort` (low/medium/high) mapped to OpenAI reasoningEffort, Anthropic thinking budget, Google thinking budget in `reasoning.ts` |
| Shared completion resolver                  | ✅ Implemented | `resolveCompletionModel()` in `completionModel.ts`; used by extraction and reasoning completions |
| `reasoning` config (agent + per-generate)   | ✅ Implemented | `Agent.reasoningConfig` JSONB (`reasoning` on the wire) + per-generate override (object replace) |
| Reflect mode (draft → critique → revise)    | ✅ Implemented | Now expressed as a `pipeline` (draft → `completion` critique → `completion` revise); legacy `mode: "reflect"` is inert (degrades + fires fallback event) |
| Debate mode (homogeneous + heterogeneous)   | ✅ Implemented | Now a `fanout` step — `runFanout()` in `reasoningPipeline.ts`; auto-personas or explicit `perspectives[]`; `rounds` (cap 3); per-perspective provider/model; perspective failures drop (quorum continues); full-failure/synthesis-failure degrade to draft; legacy `mode: "debate"` is inert |
| **Reasoning pipeline generalization**       | ✅ Implemented | `mode: "pipeline"` with an ordered list of `completion` + `fanout` steps (`runReasoningPipeline()` in `reasoningPipeline.ts`); supersedes the discrete `reflect`/`debate` modes — both now compose as steps. Caps: `MAX_STEPS=8`, `MAX_FANOUT=5`, `MAX_ROUNDS=3`, `MAX_TOTAL_COMPLETIONS=24`, per-step/pipeline timeouts |
| `applyReasoningPipeline` hook               | ✅ Implemented | Single hook in `reasoningPipelineHook.ts`; wired into `resolveGenerationResult` in `agentNonStreamGeneration.ts` |
| Trace integration                           | ✅ Implemented | Each perspective turn + synthesis recorded as a child generation (shared `traceId`, `initiatorGenerationId`) tagged with perspective name + round + model |
| `metadata.reasoning` telemetry summary      | ✅ Implemented | Parent generation summary enriched: debate adds `{ perspectives, rounds, dropped, fallback }`; reflect adds `{ fallback }` — `recordReasoningSummary()` in `reasoning.ts` |
| Silent-degradation event                    | ✅ Implemented | `agents.reasoning.fallback` event emitted on debate fallback/synthesis_failed and reflect critique_failed/revision_failed — `emitReasoningFallbackEvent()` in `reasoning.ts` |
| Async debate generate (`?async=true`)       | ❌ Not started | Larger effort; depends on the session async/poll mechanism (deferred)                            |
| `reasoning.budget` guard                    | ❌ Not started | Optional cap on total internal completions per generation (deferred)                            |
| **Discussions module (agent-callable)**     | ❌ Not started | The visible surface for reasoning: a first-class `Discussion` resource (list/inspect/retain historical thinking runs) whose `POST /discussions` auto-derives a `create-discussion` SOAT action. An agent calls it mid-loop; the outcome synthesis returns as the tool result. Reuses `runReasoningPipeline`; participants stay tool-less. This is Phase 4, extended with the agent trigger — see the "Agent-callable" note there. |
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

> **Post-PRD evolution — pipeline generalization (implemented).** Reflect and debate
> converged into a single configurable **reasoning pipeline**: `mode: "pipeline"` runs an
> ordered list of steps, where each step is a `completion` (single call — critique, revise,
> synthesize) or a `fanout` (the debate primitive: N perspectives over M rounds). Reflect is
> now a 3-step pipeline; debate is a `fanout` step + a `completion` synthesis. The discrete
> `mode: "reflect"` / `mode: "debate"` values are retained only for back-compat and are
> **inert** — they degrade to the draft and emit `agents.reasoning.fallback`. The engine lives
> in `reasoningPipeline.ts` (`runReasoningPipeline`, `runFanout`, `runCompletion`), validated by
> `validateReasoningConfig` in `reasoning.ts`, and is hooked via `applyReasoningPipeline` in
> `reasoningPipelineHook.ts`. **Phase 4 layers on this pipeline engine, not on a separate debate
> implementation.**

---

### Phase 3 — Observability & Async 🟡 Observability slice complete; async/budget deferred

**Goal:** Deliberation is slow (N×M calls); make it watchable and non-blocking.

**Deliverables:**

- ✅ **Trace integration** — each perspective turn and the synthesis step is recorded as a child generation sharing the parent's `traceId` and linked via `initiatorGenerationId`, tagged with perspective name, round, model, output, and status (`completed`/`failed`). Grouped per round via the `round` field.
- ✅ **`metadata.reasoning` summary** on the parent generation record (same pattern as `metadata.extraction`): debate records `{ mode, applied, reason, perspectives, rounds, dropped, fallback }`; reflect records `{ mode, applied, reason, fallback }`.
- ✅ **Webhook/event on deliberation fallback** — `agents.reasoning.fallback` is emitted whenever the engine silently degrades to the plain draft (debate `fallback`/`synthesis_failed`; reflect `critique_failed`/`revision_failed`), so silent degradation is detectable. Payload: `{ mode, reason, perspectives?, dropped? }`.
- ❌ **Async generate** (`?async=true` parity with sessions) returning `in_progress` + poll, for debate-mode generations — deferred (larger; depends on the session async mechanism).
- ❌ Optional **`reasoning.budget` guard** (max total completions per generation) — deferred.

**Unlocks:** The deliberation engine's cost and health are now measurable per generation, and silent fallbacks surface on webhooks instead of being invisible.

---

### Phase 4 — Discussions Resource (the visible surface) ❌ Not started · **Recommendation: thin MVP**

**Goal:** When the debate itself is the deliverable — brainstorming an idea, red-teaming a decision, expert-in-the-loop review — expose the same engine as a first-class resource. This is the original Discussions PRD, now explicitly layered on the pipeline engine (Phase 2 + the pipeline generalization above).

#### Should we build it? — Recommendation

The pipeline engine already delivers the *answer-quality* value of "multiple agents reasoning together" (multi-perspective `fanout` + synthesis, behind one `generate` call, observable in traces). **A Discussions resource is worth building when one of two bars is met** — both being things the invisible engine deliberately refuses to do:

1. **The transcript itself is the deliverable** — a **persistent, attributed, inspectable transcript** (brainstorming, red-teaming, expert review). For pure answer quality alone, prefer a `reasoning` pipeline; do not stand up a resource.
2. **An agent needs to invoke deliberation mid-loop and the run must be a durable, listable object.** This is the "redefine the thinking part of agents" driver: a tool-calling agent has no natural post-draft answer to refine, so reasoning must be something it *calls* and gets a result back from — and the project wants to list and inspect those runs historically, not just dig through per-execution traces. A resource satisfies both: its `POST /discussions` auto-derives a `create-discussion` SOAT action (the agent trigger + result return), and the row is first-class listable/permissioned/retained.

**Why a resource and not a bare tool or a trace query-view.** The engine already records every reasoning run as child generations under a shared `trace_id` (`GET /generations?trace_id=…`), so a thin query-view over traces *could* deliver listing. But a `Discussion` needs what trace telemetry cannot give: its own permissions (`discussions:Create/Read`), a stable public id to reference/re-open, retention independent of trace lifecycle, a **formation** resource type (declare a discussion in infra-as-code), and an outcome Document. Traces are execution telemetry; a Discussion is a domain object. Build the resource; the trace tree remains underneath for per-turn observability.

When that bar is met, build a **thin MVP** that *delegates deliberation to the existing pipeline engine* rather than re-implementing debate. Recommended scope:

| Decision | Recommendation | Rationale |
| --- | --- | --- |
| Build the resource? | Yes — thin MVP only | Persistent attributed transcript **and** an agent-callable, listable thinking run are the capabilities the engine lacks |
| Re-implement deliberation? | **No** — reuse `runFanout` / `runReasoningPipeline` | The fanout engine already does perspectives + rounds + synthesis + traces |
| Agent trigger (MVP) | **Yes — auto-derived `create-discussion` SOAT action** | `POST /discussions` becomes an MCP/SOAT tool for free via `soatTools.ts`; the agent calls it mid-loop and reads the outcome as the tool result. This is the answer to "how do branches return to the main agent" and "when does a tool-only agent call them" |
| Participant identity (MVP) | **Engine perspectives (tool-less)** | Maximizes reuse; sidesteps the tools-per-turn decision; leaves a clean seam to real Agents |
| Lifecycle (MVP) | **Synchronous** `pending → running → completed/failed` | Defer async/poll until the session async mechanism (Phase 3) lands. Note: a synchronous `create-discussion` tool call blocks the calling agent for the full N×M run — bounded by engine caps + timeouts, same profile as a nested `create-agent-generation`; async is the deferred upgrade |
| Turn policy (MVP) | `round_robin` only | `organizer_selects` needs the organizer decision protocol — defer |
| Human-in-the-loop (MVP) | Deferred | Reuses orchestration `requires_action` later; not MVP |

#### Thin MVP design

- **`Discussion` (`disc_`)**: `project_id`, `topic`, `status` (`pending|running|completed|failed`), `max_rounds` (cap 3), `conversation_id` (the persisted transcript), `outcome_document_id` (the stored synthesis), `synthesis` override triple, `tags`. The synchronous create response also inlines the `outcome` synthesis text so the `create-discussion` tool result carries it directly (no follow-up read required); the Document is the durable copy.
- **`DiscussionParticipant` (`dpt_`)**: `discussion_id`, `actor_id`, `prompt` (persona), `position`.
- **Transcript reuse** — persisted as a real [Conversation](../packages/website/docs/modules/conversations.md) with [Actor](../packages/website/docs/modules/actors.md) authorship (`addConversationMessage`), one Actor per participant; outcome stored as a Document. **No new transcript machinery.**
- **`runDiscussion`** maps participants → the engine's `fanout` perspective list, calls `runReasoningPipeline`/`runFanout` (models resolved via `resolveCompletionModel`), then **persists each turn attributed to its Actor** and the synthesis as the outcome Document. Failure degrades gracefully (deep thinking must never make the resource *less* reliable).
- **Agent trigger — `create-discussion` SOAT action (auto-derived).** `POST /discussions` runs **synchronously** and returns the completed discussion including its `outcome` synthesis, so when an agent calls the auto-derived `create-discussion` tool mid-loop, the outcome comes back as the tool result and re-enters the caller's message history. No hand-written tool layer — `soatTools.ts` derives the action from the OpenAPI spec. This is how the resource closes the original "redefine thinking" gap:
  - **Return to the main agent** = the tool result carries the outcome synthesis; participants stay tool-less, so only the reduced conclusion re-enters the loop.
  - **When the agent calls it** = whenever the model selects the `create-discussion` tool; `tool_choice: required` or a `step_rules` pin forces "discuss before acting."
  - **History** = every call is a first-class `Discussion` row: `GET /discussions` to list, `GET /discussions/:id` for the transcript Conversation + outcome Document.
- Full module surface per `.claude/rules/modules.md`: REST + OpenAPI, permissions, formation module + `DiscussionResourceProperties`, SDK/CLI regen (MCP auto-derived), docs, tests (TDD), smoke steps.

#### Deferred to a later Discussions phase (clean seams kept)

- **Async run** (`?async=true`, `in_progress` + poll) — depends on the session async mechanism (Phase 3 deferred item).
- **Human participants** via `paused` + `required_action`, mirroring `executeHumanNode` in `orchestrationNodeExecutors.ts`.
- **`organizer_selects` turn policy** + organizer decision protocol (continue/end, next speaker) — prompt-based JSON with lenient parsing.
- **Real Agents with tools as participants** — the resource surface likely wants real Agents; the engine deliberately avoids tools. The Actor→participant seam makes this a later swap.
- **Orchestration `discussion` node type**; webhooks; cancellation/pause lifecycle states.

> Original Phase 4 design (organizer agent, full async-first lifecycle, human-in-the-loop, formation, orchestration node) is preserved in the git history of this file and folded into the "deferred" list above.

---

## Override Semantics

All provider/model/prompt overrides in this PRD — `critique`, each `perspectives[]` entry, and `synthesis` — use the **same contract established by `knowledge_config.extraction`**:

| Field            | Default                | Rule                                                                                       |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `ai_provider_id` | agent's provider       | Must belong to the agent's project (validated at call time; prevents borrowing another project's secret) |
| `model`          | chain below            | `model` → override provider's `default_model` (when `ai_provider_id` set) → agent's `model` → agent provider's `default_model` |
| `prompt`         | built-in instructions  | Replaces task instructions only; engine-owned scaffolding (debate transcript framing, synthesis contract) is always appended |

**Shared implementation (done):** `resolveCompletionModel({ agentId, projectIds, aiProviderId?, model? })` in `completionModel.ts` is the single source of truth for the resolution + project-scope security check, used by memory extraction and every reasoning step (completion + fanout perspectives + synthesis). Phase 4's `runDiscussion` reuses it unchanged.

## Reasoning Config Schema

Stored as `reasoningConfig` JSONB on the `agents` table; per-generate `reasoning` body field overrides it (object replace, not deep merge). All snake_case on the wire per case convention.

The shipped engine uses **`mode: "pipeline"`** with an ordered list of `steps`. Each step is a `completion` (single call — critique, revise, synthesize) or a `fanout` (the debate primitive: N `perspectives` over `rounds`). `effort` composes with any mode. The legacy `mode: "reflect"` / `mode: "debate"` values are retained for back-compat only and are **inert** (they degrade to the draft and fire `agents.reasoning.fallback`).

```jsonc
// Provider-native reasoning only — no orchestration
{ "reasoning": { "effort": "high" } }

// Reflect, expressed as a pipeline — draft → critique → revise
{
  "reasoning": {
    "mode": "pipeline",
    "steps": [
      { "name": "critique", "kind": "completion", "prompt": "Critique the draft; list concrete improvements or reply APPROVED." },
      { "name": "revise",   "kind": "completion", "prompt": "Revise the draft using the critique.", "output": true, "halt_if_equals": "APPROVED" }
    ]
  }
}

// Debate, expressed as a pipeline — heterogeneous fanout → synthesis
{
  "reasoning": {
    "mode": "pipeline",
    "steps": [
      {
        "name": "debate", "kind": "fanout", "rounds": 2,
        "perspectives": [
          { "name": "Skeptic",  "prompt": "Attack the strongest claim and surface hidden assumptions.", "ai_provider_id": "aip_anthropic", "model": "claude-sonnet-4-6" },
          { "name": "Advocate", "prompt": "Steelman the proposal with concrete evidence.", "model": "gpt-4o-mini" },
          { "name": "Pragmatist" }
        ]
      },
      {
        "name": "synthesis", "kind": "completion", "output": true,
        "ai_provider_id": "aip_flagship",
        "prompt": "Weigh the arguments; commit to a single recommendation with rationale."
      }
    ]
  }
}
```

| Field          | Type                | Default  | Notes                                                                                  |
| -------------- | ------------------- | -------- | -------------------------------------------------------------------------------------- |
| `effort`       | string              | —        | `low` \| `medium` \| `high` — provider-native reasoning; composes with `mode`           |
| `mode`         | string              | `"none"` | `none` \| `pipeline` (legacy `reflect` / `debate` accepted but inert)                   |
| `steps`        | object[]            | —        | Pipeline only — ordered `completion` / `fanout` steps (`MAX_STEPS=8`)                   |
| `budget`       | integer             | —        | Phase 3 — max total internal completions (`MAX_TOTAL_COMPLETIONS=24` cap today)         |

**Step fields:** `name`, `kind` (`completion` \| `fanout`), `prompt`, `ai_provider_id?`, `model?`, `temperature?`, `output?` (this step's text becomes the answer), `halt_if_equals?`. Fanout adds `count?` (auto-personas) or `perspectives[]` (`{ name?, prompt?, ai_provider_id?, model? }`, 2–5) and `rounds?` (cap 3).

## Relationship to Other Modules

| Concern                       | Owner                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| Provider/model resolution     | Shared completion resolver (also used by memory extraction)             |
| Deliberation transcript (P2)  | Engine state → trace steps only                                         |
| Deliberation transcript (P4)  | Conversations (+ Actors for authorship)                                 |
| Observability                 | Traces + `metadata.reasoning` on the generation record                  |
| Cost controls                 | `max_rounds`, perspective count limits, `budget`                        |

## Open Questions

1. **Auto-escalation** — should a cheap triage step decide *when* to debate ("is this question contested/hard?") instead of a static config? Proposal: defer; per-request override covers it manually.
2. **Knowledge injection in perspectives** — do perspective calls get the agent's `knowledge_config` context? Proposal: yes for the question context (it's the same question), but no self-retrieval tools.
3. **Streaming** — debate mode can't stream the final answer until synthesis; stream synthesis tokens only, or emit per-round trace events? Proposal: Phase 3 decision.
4. **Reflect + debate composition** — ~~allow synthesis output to be reflected on?~~ **Resolved** by the pipeline generalization: both compose as `steps`, so a `fanout` synthesis can be followed by `completion` critique/revise steps in one pipeline.
