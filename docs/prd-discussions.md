# PRD: Deep Thinking — Reasoning Engine & Discussions

> Supersedes the original "Discussions Module" PRD. The multi-agent deliberation idea is re-layered: the **deliberation engine** ships first as invisible machinery behind the existing generate flow (a `reasoning` config — "deep thinking"), and the user-facing **Discussions resource** becomes a later surface on the same engine. The original Discussions design is preserved as Phase 4.

## Implementation Status

| Component                                   | Status         | Notes                                                                                          |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Provider-native reasoning passthrough       | ✅ Implemented | `reasoning.effort` (low/medium/high) mapped to OpenAI reasoningEffort, Anthropic thinking budget, Google thinking budget in `reasoning.ts` |
| Shared completion resolver                  | ✅ Implemented | `resolveCompletionModel()` in `completionModel.ts`; used by extraction and reasoning completions |
| `reasoning` config (agent + per-generate)   | ✅ Implemented | `Agent.reasoningConfig` JSONB (`reasoning` on the wire) + per-generate override (object replace) |
| Reflect mode (draft → critique → revise)    | ✅ Implemented | `applyReflection()` in `reasoning.ts`; APPROVED short-circuit; failures degrade to the draft     |
| Debate mode (homogeneous + heterogeneous)   | ✅ Implemented | `runDebate()` in `deliberation.ts`; auto-personas or explicit `perspectives[]`; `maxRounds` (cap 3); `synthesis` override triple; perspective failures drop (quorum continues); full-failure/synthesis-failure degrade to draft |
| `applyOrchestration` pipeline hook          | ✅ Implemented | Single hook dispatches to reflect or debate; wired into `resolveGenerationResult` in `agentNonStreamGeneration.ts` |
| Trace integration                           | ❌ Not started | Each internal call recorded as trace steps tagged with perspective name + model                 |
| Discussions resource module                 | ❌ Not started | Visible transcript, organizer-selected turns, human participants (original PRD, now Phase 4)    |

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

---

### Phase 3 — Observability & Async ❌ Not started

**Goal:** Deliberation is slow (N×M calls); make it watchable and non-blocking.

**Deliverables:**

- Async generate (`?async=true` parity with sessions) returning `in_progress` + poll, for debate-mode generations
- Trace UI affordances: deliberation steps grouped per round, perspective name + model on each step; `metadata.reasoning` summary on the generation record (`{ mode, perspectives, rounds, dropped, fallback }`) — same pattern as `metadata.extraction`
- Optional `reasoning.budget` guard (max total completions per generation)
- Webhook/event on deliberation fallback so silent degradation is detectable

---

### Phase 4 — Discussions Resource (the visible surface) ❌ Not started

**Goal:** When the debate itself is the deliverable — brainstorming an idea, red-teaming a decision, expert-in-the-loop review — expose the same engine as a first-class resource. This is the original Discussions PRD, now explicitly layered on the Phase 2 engine.

**Summary of the original design (full details in the git history of this file):**

- `Discussion` (`disc_`) + `DiscussionParticipant` (`dpt_`): topic, participants (agents with personas), organizer agent, `turn_policy: round_robin | organizer_selects`, `max_rounds`, status lifecycle `pending → running → paused → completed/failed/cancelled`
- Transcript persisted as a real [Conversation](../packages/website/docs/modules/conversations.md) with [Actor](../packages/website/docs/modules/actors.md) authorship (escape hatch retained); outcome stored as a document
- Organizer decision protocol (continue/end, next speaker) — prompt-based JSON with lenient parsing and safe fallback until agents support structured output
- Human participants via `paused` + `required_action` (mirroring orchestration human nodes); webhooks; formation support; optional orchestration `discussion` node type
- Differences from the Phase 2 engine: persistent transcript (Conversation vs trace), participant identity (Actors vs prompt personas), turn policies with an organizer, human-in-the-loop, async-first lifecycle

**Key decision deferred to this phase:** whether participants reference full Agents (tools enabled per turn) or the engine's tool-less perspective calls. The resource surface likely wants real Agents; the deep-thinking engine deliberately avoids tools.

---

## Override Semantics

All provider/model/prompt overrides in this PRD — `critique`, each `perspectives[]` entry, and `synthesis` — use the **same contract established by `knowledge_config.extraction`**:

| Field            | Default                | Rule                                                                                       |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `ai_provider_id` | agent's provider       | Must belong to the agent's project (validated at call time; prevents borrowing another project's secret) |
| `model`          | chain below            | `model` → override provider's `default_model` (when `ai_provider_id` set) → agent's `model` → agent provider's `default_model` |
| `prompt`         | built-in instructions  | Replaces task instructions only; engine-owned scaffolding (debate transcript framing, synthesis contract) is always appended |

**Shared implementation:** extract the resolution + project-scope check currently in `memoryExtractionCompletion.ts` into a shared helper (e.g. `resolveCompletionModel({ agentId, projectIds, aiProviderId?, model? })`) used by extraction, reflect, debate, and synthesis — one source of truth for the security check.

## Reasoning Config Schema

Stored as `reasoningConfig` JSONB on the `agents` table; per-generate `reasoning` body field overrides it (object replace, not deep merge). All snake_case on the wire per case convention.

```jsonc
// Agent-level default — cheap reflect everywhere
{ "reasoning": { "mode": "reflect" } }

// Per-request escalation — heterogeneous debate for a hard question
{
  "reasoning": {
    "mode": "debate",
    "max_rounds": 2,
    "perspectives": [
      { "name": "Skeptic",  "prompt": "Attack the strongest claim and surface hidden assumptions.", "ai_provider_id": "aip_anthropic", "model": "claude-sonnet-4-6" },
      { "name": "Advocate", "prompt": "Steelman the proposal with concrete evidence.", "model": "gpt-4o-mini" },
      { "name": "Pragmatist" }
    ],
    "synthesis": {
      "ai_provider_id": "aip_flagship",
      "prompt": "Weigh the arguments; commit to a single recommendation with rationale."
    }
  }
}
```

| Field          | Type                | Default  | Notes                                                          |
| -------------- | ------------------- | -------- | --------------------------------------------------------------- |
| `mode`         | string              | `"none"` | `none` \| `reflect` \| `debate`                                 |
| `critique`     | object              | —        | Reflect only — override triple for the critique pass            |
| `perspectives` | integer \| object[] | `3`      | Debate only — count (auto personas) or explicit perspective list |
| `max_rounds`   | integer             | `1`      | Debate only — hard cap 3                                        |
| `synthesis`    | object              | —        | Debate only — override triple + prompt for the final pass       |
| `budget`       | integer             | —        | Phase 3 — max total internal completions                        |

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
4. **Reflect + debate composition** — allow synthesis output to be reflected on? Proposal: no; keep modes exclusive until there's a proven need.
