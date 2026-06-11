# PRD: Discussions Module

## Implementation Status

| Component                               | Status         | Notes                                                                                       |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| Discussion model (CRUD)                 | ❌ Not started | Model, lib, REST, OpenAPI, permissions, tests, docs                                          |
| DiscussionParticipant model             | ❌ Not started | Join table linking discussions to agents with per-participant persona                       |
| Discussion run loop (`round_robin`)     | ❌ Not started | Async server-side loop over `generateConversationMessage()` with fixed speaker order        |
| Organizer synthesis                     | ❌ Not started | Final organizer call producing the `outcome` document                                       |
| Organizer decision protocol             | ❌ Not started | Prompt-based JSON contract for `continue`/`end` and `next_speaker`                          |
| `organizer_selects` turn policy         | ❌ Not started | Organizer picks the next speaker each turn                                                  |
| Lifecycle events + webhooks             | ❌ Not started | `discussion.completed` / `discussion.failed` via eventBus + webhook dispatcher              |
| Streaming (SSE turn feed)               | ❌ Not started | Live feed of turns as they are generated                                                    |
| Human participants                      | ❌ Not started | Pause/`required_action` flow modelled after orchestration human nodes                       |
| Formation support                       | ❌ Not started | `discussionsFormationModule` + `DiscussionResourceProperties` in `formations.yaml`          |
| Orchestration `discussion` node type    | ❌ Not started | Embed a discussion as a single node inside an orchestration DAG                             |

## Implementation Phases

### Phase 1 — Core Model & Round-Robin Loop ❌ Not started

**Goal:** Create a discussion with N participant agents and an organizer, start it, and poll until the organizer's synthesis is ready. Turn order is deterministic (`round_robin`); the organizer only synthesizes at the end.

**Deliverables:**

- `Discussion` and `DiscussionParticipant` DB models
- `POST/GET/PATCH/DELETE /api/v1/discussions` — CRUD
- `POST /api/v1/discussions/:discussionId/start` — kicks off the async run loop; returns `202 Accepted`
- `POST /api/v1/discussions/:discussionId/cancel` — cancels a running discussion
- Run loop in `src/lib/discussionEngine.ts`: seeds the underlying conversation with the topic, iterates participants in declared order for `max_rounds` rounds, each turn via the existing conversation generate plumbing
- Organizer synthesis call after the last round; result stored as a document and exposed as `outcome`
- Auto-created [Actors](../packages/website/docs/modules/actors.md) per participant carrying persona `instructions`
- OpenAPI spec, SDK/CLI regeneration, permissions JSON, unit tests, smoke test steps, module docs

**Unlocks:** "Have three agents debate this idea and give me the organizer's summary" in two API calls.

---

### Phase 2 — Organizer Control ❌ Not started

**Goal:** Make the discussion adaptive. The organizer decides whether the discussion should continue after each round and, with `turn_policy: organizer_selects`, which participant speaks next.

**Deliverables:**

- Organizer decision protocol (see [Organizer Decision Protocol](#organizer-decision-protocol)) — prompt-based JSON with lenient parsing, one retry, and a safe fallback to `round_robin`/`continue`
- `turn_policy` field: `round_robin` (default) | `organizer_selects`
- Early termination: organizer returns `action: "end"` → loop stops before `max_rounds`
- `rounds_completed` and `turns` counters on the Discussion resource
- Decision turns recorded in the trace (but **not** appended to the conversation transcript)
- Tests covering decision parsing, fallback behaviour, and early termination

**Unlocks:** Moderated debates that converge when consensus is reached instead of burning a fixed number of rounds.

---

### Phase 3 — Observability & Events ❌ Not started

**Goal:** Make long-running discussions observable without polling.

**Deliverables:**

- `discussion.started`, `discussion.turn.completed`, `discussion.completed`, `discussion.failed` events emitted on the eventBus and deliverable via [Webhooks](../packages/website/docs/modules/webhooks.md)
- `GET /api/v1/discussions/:discussionId/turns` — paginated turn listing (participant, round, message ref)
- Optional SSE stream (`?stream=true` on start) emitting one event per completed turn
- Trace ancestry: every turn's generation links to a shared discussion trace ID

**Unlocks:** UIs that render the debate live; automation that reacts to a finished discussion.

---

### Phase 4 — Human Participants ❌ Not started

**Goal:** Let a human join the panel. When it is the human participant's turn, the discussion pauses with a `required_action`, mirroring orchestration human nodes.

**Deliverables:**

- Participant entries with `actor_id` but no `agent_id` are treated as human participants
- Status `paused` + `required_action: { type: "human_turn", participant_id, prompt }`
- `POST /api/v1/discussions/:discussionId/turn-inputs` — submit the human's message and resume the loop
- Tests covering pause/resume and timeout behaviour

**Unlocks:** Expert-in-the-loop reviews — agents debate, a human weighs in, the organizer synthesizes everything.

---

### Phase 5 — Composition ❌ Not started

**Goal:** Make discussions a building block.

**Deliverables:**

- `discussionsFormationModule.ts` + `DiscussionResourceProperties` schema in `formations.yaml` so panels are templatable
- New orchestration node type `discussion`: runs a discussion to completion and maps `outcome` into orchestration state
- Reusable panel definitions (create a discussion from an existing one's participants with a new topic)

**Unlocks:** "Run a panel debate" as one deterministic step inside a larger orchestration pipeline.

---

## Overview

The Discussions module coordinates a **multi-agent debate**: a set of participant [Agents](../packages/website/docs/modules/agents.md), each with its own persona, take turns discussing a **topic** in a shared transcript, while an **organizer agent** moderates the flow and produces a final synthesis (the **outcome**).

A Discussion is a thin coordination layer over existing primitives:

- The transcript **is** a [Conversation](../packages/website/docs/modules/conversations.md) — every turn is a regular conversation message with `actor_id` authorship and `agent_id` attribution, generated through the existing `generateConversationMessage` plumbing (advisory locks, traces, tools all included).
- Each participant **is** an [Actor](../packages/website/docs/modules/actors.md) linked to an agent — the actor's `instructions` carry the persona ("argue the contrarian position").
- The organizer **is** a regular agent — no special agent type is introduced.

What the module adds is the **server-side loop**: turn scheduling, round counting, organizer decision handling, stop conditions, and an async run lifecycle — so a client gets a full debate plus synthesis from a single `start` call instead of orchestrating dozens of generate calls itself.

This resolves the roadmap's "Agent Handoff / multi-agent" direction for the deliberation use case and fills the gap between:

| Module             | Shape                                                          |
| ------------------ | -------------------------------------------------------------- |
| **Chats**          | Raw LLM completions — caller manages everything                |
| **Sessions**       | 1 user ↔ 1 agent — automated single-agent dialogue            |
| **Conversations**  | Multi-party engine — primitives only, caller drives the loop  |
| **Discussions**    | N agents + 1 organizer — automated multi-agent deliberation    |
| **Orchestrations** | Deterministic DAG — known steps, no LLM-driven control flow    |

### Why Not Orchestrations

Orchestrations are explicitly a **DAG**: the engine rejects cycles (`ORCHESTRATION_CYCLE_DETECTED`) and its contract is "use when you know the exact steps in advance". A discussion violates both constraints:

1. **It is iterative** — rounds repeat until convergence; the round count is not known in advance. Expressing this in a DAG requires statically unrolling rounds.
2. **Control flow is LLM-driven** — the organizer decides who speaks next and when to stop. Orchestration routing (`condition` nodes) is JSON Logic over state, not LLM judgment.
3. **State is a shared transcript** — orchestration agent nodes exchange data through `input_mapping`/`output_mapping` on a state object; participants in a debate need to see the full ordered history with authorship, which is exactly what a Conversation already provides.

A *fixed-shape* variant (fan-out N opinions → fan-in organizer synthesis) is already expressible as an orchestration today and remains the right tool when no iteration is needed. Discussions and Orchestrations compose rather than compete — Phase 5 embeds a discussion as a single orchestration node.

## Key Concepts

### Discussion

A Discussion is an **instance**, not a template (like a Session, unlike an Orchestration). It is created with a topic, a panel, and an organizer; started once; and ends `completed` with an outcome or `failed` with an error.

| Field                | Type             | Required | Description                                                                                     |
| -------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `id`                 | string           | auto     | Public ID with `disc_` prefix                                                                    |
| `project_id`         | string           | yes      | Owning project                                                                                   |
| `name`               | string           | no       | Human-readable name                                                                              |
| `topic`              | string           | yes      | The idea under discussion; seeds the transcript as the first `user` message                      |
| `organizer_agent_id` | string           | yes      | Agent that moderates and synthesizes (`agt_` prefix)                                             |
| `participants`       | array            | yes      | 2–10 participant definitions (see [Participants](#participants))                                 |
| `turn_policy`        | string           | no       | `round_robin` (default) \| `organizer_selects`                                                   |
| `max_rounds`         | integer          | no       | Hard upper bound on rounds (default `3`, max `20`). Always enforced regardless of turn policy.   |
| `status`             | string           | auto     | `pending` \| `running` \| `paused` \| `completed` \| `failed` \| `cancelled`                     |
| `conversation_id`    | string           | auto     | Underlying conversation (escape hatch to the full Conversations API)                             |
| `rounds_completed`   | integer          | auto     | Number of completed rounds                                                                       |
| `outcome`            | string \| null   | auto     | Organizer's final synthesis text (`null` until completed)                                        |
| `outcome_document_id`| string \| null   | auto     | Document holding the synthesis                                                                   |
| `required_action`    | object \| null   | auto     | Present when `paused` (Phase 4 human turns)                                                      |
| `error`              | object \| null   | auto     | Error details when `failed`                                                                      |
| `tags`               | object           | no       | Free-form key-value metadata                                                                     |
| `created_at`         | string           | auto     | ISO 8601                                                                                         |
| `updated_at`         | string           | auto     | ISO 8601                                                                                         |

### Participants

Each participant binds an agent to the discussion with an optional persona. On creation the engine auto-creates an [Actor](../packages/website/docs/modules/actors.md) linked to the agent, with the persona stored in the actor's `instructions` — reusing the existing instruction-composition path for generate calls.

| Field          | Type           | Required | Description                                                                                  |
| -------------- | -------------- | -------- | --------------------------------------------------------------------------------------------- |
| `id`           | string         | auto     | Public ID with `dpt_` prefix                                                                  |
| `agent_id`     | string         | yes\*    | The agent that generates this participant's turns                                             |
| `actor_id`     | string         | auto/no  | Auto-created actor; may be supplied to reuse an existing actor. \*Phase 4: an `actor_id` without `agent_id` denotes a human participant |
| `name`         | string         | yes      | Display name used in the transcript and organizer prompts (e.g. `"Optimist"`). Unique per discussion. |
| `instructions` | string \| null | no       | Persona prompt composed into the agent's system prompt for this discussion's turns           |
| `position`     | integer        | auto     | Speaking order for `round_robin`                                                              |

The same `agent_id` may appear in multiple participants with different personas (one model arguing both sides is a valid panel).

### Organizer

The organizer is a normal agent referenced by `organizer_agent_id`. The engine calls it in two distinct modes, each with an engine-supplied system prompt wrapping the agent's own instructions:

1. **Decision mode** (Phase 2, after each round — or each turn under `organizer_selects`): the organizer sees the transcript and returns a JSON decision (see below). Decision generations are traced but **not** written to the transcript.
2. **Synthesis mode** (final step): the organizer sees the full transcript and produces the outcome. The synthesis **is** appended to the conversation as the final `assistant` message (authored by the organizer's actor) and stored as `outcome` / `outcome_document_id`.

### Organizer Decision Protocol

Agents do not currently support structured output (`response_format`), so the decision contract is prompt-based:

```
Engine prompt (appended to organizer instructions, decision mode):
  "Respond with a single JSON object and nothing else:
   { \"action\": \"continue\" | \"end\",
     \"next_speaker\": \"<participant name>\",   // only when asked to pick
     \"reason\": \"<one sentence>\" }"
```

Parsing is lenient (first JSON object found in the reply). On parse failure the engine retries **once** with an error-correction prompt; on a second failure it falls back to the safe default — `continue` with `round_robin` order — so a malformed organizer reply degrades the discussion rather than failing it. `max_rounds` remains the hard stop in all cases.

If agents gain native structured output later, the protocol swaps to it without changing the API surface.

### The Discussion Loop

```
Input: discussion (status: pending)

START
  status ← running
  Append topic as first message (role: user) to the conversation.

LOOP (round = 1 .. max_rounds)
  Determine speaker order:
    round_robin       → participants by position
    organizer_selects → ask organizer for next_speaker before each turn
  For each speaker:
    If human participant → status ← paused, set required_action, WAIT   (Phase 4)
    Else → generateConversationMessage(conversation_id, speaker.agent_id)
           with the speaker's actor instructions composed in.
           The reply is appended as an assistant message
           (actor_id = speaker.actor_id, agent_id = speaker.agent_id).
  rounds_completed ← round
  Ask organizer: continue or end?                                        (Phase 2)
    action == "end" → break

SYNTHESIZE
  Call organizer in synthesis mode over the full transcript.
  Append synthesis as final assistant message; store outcome + outcome_document_id.
  status ← completed

ON ERROR (any turn or synthesis fails)
  status ← failed, error ← { code, message, participant_id?, round }
ON CANCEL
  status ← cancelled (current in-flight generation completes; no further turns)
```

The loop runs **asynchronously** server-side: `start` returns `202` immediately and clients poll `GET /discussions/:id` (or subscribe to webhooks, Phase 3). The existing per-conversation advisory lock serializes turns; the engine never issues concurrent generate calls for the same discussion. `start` on a discussion that is not `pending` returns `409 Conflict`.

### Prompt Visibility

Every participant turn receives:

- The participant agent's own `instructions` (unchanged — agents stay reusable outside discussions)
- The participant's persona `instructions` (via the actor, existing composition path)
- An engine preamble identifying the discussion: topic, participant roster with names, and the rule "you are <name>; reply with your next contribution only"
- The full transcript so far, with each prior turn attributed to its participant name

This means participants always argue with full context, which is the property orchestration state-mapping cannot provide.

### Stop Conditions

| Condition                  | Behaviour                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `max_rounds` reached       | Loop exits; synthesis runs. Always enforced (hard cap `20`).    |
| Organizer `action: "end"`  | Loop exits early; synthesis runs. (Phase 2)                     |
| `POST .../cancel`          | No further turns; **no synthesis**; status `cancelled`.         |
| Turn/synthesis error       | Status `failed` with `error`; transcript preserved for debugging.|

### Relationship to Other Modules

| Concern              | Owned by Discussions | Delegated to                                  |
| -------------------- | -------------------- | ---------------------------------------------- |
| Turn scheduling      | ✅                   | —                                              |
| Transcript storage   | —                    | Conversations (`conversation_id` escape hatch) |
| Persona instructions | —                    | Actors (`instructions`)                        |
| Text generation      | —                    | Agents (full tool support per turn)            |
| Observability        | —                    | Generations / Traces (one trace per discussion)|
| Delivery of events   | —                    | Webhooks (Phase 3)                             |

Deleting a discussion cascades to its underlying conversation and auto-created actors (mirroring session deletion semantics). Supplied (pre-existing) actors are **not** deleted.

## Data Model

### Discussion Table

| Column            | Type        | Constraints                                                            |
| ----------------- | ----------- | ----------------------------------------------------------------------- |
| id                | INTEGER     | PK, auto-increment                                                      |
| publicId          | VARCHAR(32) | UNIQUE, NOT NULL, `disc_` prefix                                        |
| projectId         | INTEGER     | FK → Project, NOT NULL                                                  |
| conversationId    | INTEGER     | FK → Conversation, NOT NULL                                             |
| organizerAgentId  | INTEGER     | FK → Agent, NOT NULL                                                    |
| name              | VARCHAR     | NULL                                                                    |
| topic             | TEXT        | NOT NULL                                                                |
| turnPolicy        | VARCHAR(20) | NOT NULL, enum: `round_robin`, `organizer_selects`, default `round_robin` |
| maxRounds         | INTEGER     | NOT NULL, default 3, CHECK 1–20                                         |
| status            | VARCHAR(20) | NOT NULL, enum, default `pending`                                       |
| roundsCompleted   | INTEGER     | NOT NULL, default 0                                                     |
| outcomeDocumentId | INTEGER     | FK → Document, NULL                                                     |
| requiredAction    | JSONB       | NULL                                                                    |
| error             | JSONB       | NULL                                                                    |
| tags              | JSONB       | NULL, default `{}`                                                      |
| createdAt         | TIMESTAMP   | NOT NULL                                                                |
| updatedAt         | TIMESTAMP   | NOT NULL                                                                |

### DiscussionParticipant Table

| Column       | Type        | Constraints                          |
| ------------ | ----------- | ------------------------------------- |
| id           | INTEGER     | PK, auto-increment                    |
| publicId     | VARCHAR(32) | UNIQUE, NOT NULL, `dpt_` prefix       |
| discussionId | INTEGER     | FK → Discussion, NOT NULL             |
| agentId      | INTEGER     | FK → Agent, NULL (Phase 4: human)     |
| actorId      | INTEGER     | FK → Actor, NOT NULL                  |
| name         | VARCHAR     | NOT NULL                              |
| position     | INTEGER     | NOT NULL                              |
| createdAt    | TIMESTAMP   | NOT NULL                              |
| updatedAt    | TIMESTAMP   | NOT NULL                              |

**Indexes:**

- `UNIQUE (publicId)` on both tables
- `(projectId)` on Discussion — project-scoped listing
- `(discussionId)` on DiscussionParticipant
- `UNIQUE (discussionId, name)` — participant names are the organizer's addressing scheme
- `UNIQUE (discussionId, position)` — stable round-robin order

Deleting an Agent referenced by a participant of a **non-terminal** discussion is blocked (`409`); for terminal discussions the participant's `agentId` is set NULL, preserving the transcript (same philosophy as actor deletion rules in Conversations).

## Permissions

| Permission                      | Endpoint                                            |
| ------------------------------- | ---------------------------------------------------- |
| `discussions:CreateDiscussion`  | `POST /api/v1/discussions`                           |
| `discussions:ListDiscussions`   | `GET /api/v1/discussions`                            |
| `discussions:GetDiscussion`     | `GET /api/v1/discussions/:discussionId`              |
| `discussions:UpdateDiscussion`  | `PATCH /api/v1/discussions/:discussionId`            |
| `discussions:DeleteDiscussion`  | `DELETE /api/v1/discussions/:discussionId`           |
| `discussions:StartDiscussion`   | `POST /api/v1/discussions/:discussionId/start`       |
| `discussions:CancelDiscussion`  | `POST /api/v1/discussions/:discussionId/cancel`      |
| `discussions:ListDiscussionTurns` | `GET /api/v1/discussions/:discussionId/turns` (Phase 3) |

Creating a discussion additionally requires read access to the referenced agents. The run loop executes generations under the discussion's project scope — participants' agents must belong to the same project.

## REST API

All body fields use `snake_case` per project convention.

| Method | Path                                          | Description                                                              |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/v1/discussions`                         | Create a discussion (status `pending`). `auto_start: true` starts it immediately. |
| GET    | `/api/v1/discussions`                         | List discussions (filter by `project_id`, `status`)                       |
| GET    | `/api/v1/discussions/:discussionId`           | Get a discussion incl. status, `rounds_completed`, `outcome`              |
| PATCH  | `/api/v1/discussions/:discussionId`           | Update name/tags; topic/participants/policy only while `pending`          |
| DELETE | `/api/v1/discussions/:discussionId`           | Delete (cascades to conversation + auto-created actors); `409` while `running` |
| POST   | `/api/v1/discussions/:discussionId/start`     | Start the async loop; `202 Accepted`; `409` if not `pending`              |
| POST   | `/api/v1/discussions/:discussionId/cancel`    | Cancel a `running`/`paused` discussion                                    |
| GET    | `/api/v1/discussions/:discussionId/turns`     | Paginated turn list (Phase 3)                                             |
| POST   | `/api/v1/discussions/:discussionId/turn-inputs` | Submit a human participant's turn while `paused` (Phase 4)              |

### Example — create and run a discussion

```json
POST /api/v1/discussions
{
  "project_id": "proj_ABC",
  "name": "Pricing model debate",
  "topic": "Should we move from seat-based to usage-based pricing?",
  "organizer_agent_id": "agt_moderator",
  "turn_policy": "round_robin",
  "max_rounds": 3,
  "auto_start": true,
  "participants": [
    { "agent_id": "agt_a", "name": "Growth advocate",
      "instructions": "Argue for usage-based pricing. Focus on expansion revenue." },
    { "agent_id": "agt_a", "name": "CFO perspective",
      "instructions": "Argue for predictable revenue. Challenge optimistic projections." },
    { "agent_id": "agt_b", "name": "Customer voice",
      "instructions": "Represent existing customers. Surface migration risks." }
  ]
}

→ 201 { "id": "disc_01", "status": "running", "conversation_id": "conv_42", ... }
```

```json
GET /api/v1/discussions/disc_01

→ 200 {
  "id": "disc_01",
  "status": "completed",
  "rounds_completed": 2,
  "outcome": "The panel converged on a hybrid model: ...",
  "outcome_document_id": "doc_99",
  "conversation_id": "conv_42"
}
```

The full transcript is available via `GET /api/v1/conversations/conv_42/messages` — no new transcript API is introduced.

## Module Checklist Impact

Per `modules.md`, shipping Phase 1 requires:

- `packages/server/src/lib/discussions.ts` + `discussionEngine.ts`
- `packages/server/src/rest/v1/discussions.ts` (+ mount in `index.ts`) with `@openapi` blocks
- `packages/server/src/rest/openapi/v1/discussions.yaml` → regenerate SDK (`pnpm --filter @soat/sdk generate`) and CLI (`pnpm --filter @soat/cli generate`); MCP tools derive automatically
- `packages/server/src/permissions/discussions.json` → regenerate permissions page
- `packages/website/docs/modules/discussions.md`
- `packages/server/tests/unit/tests/rest/discussions.test.ts` (happy path, `401`, `403`, `404`, `409` on double-start, loop behaviour with `mockCreateGeneration`)
- Smoke test steps in `tests/smoke-tests.sh` via `$SOAT_CLI` (create → start → poll → assert `status == "completed"` and `outcome` present; do **not** assert LLM content)

## Open Questions

1. **Decision-mode cost** — under `organizer_selects`, the organizer is called before every turn (N×M extra generations). Should decision calls use a cheaper model override on the organizer agent? Proposal: defer; users can point `organizer_agent_id` at a cheap-model agent.
2. **Turn token budget** — long debates can blow the context window. Proposal: defer to the agents' existing context handling in Phase 1; consider transcript summarization (reusing memories) later.
3. **Reusable panels** — should a "panel" (participants + organizer, no topic) be a separate template resource? Proposal: no for v1; formations (Phase 5) cover templating.
4. **Per-turn timeout** — generations can hang on provider issues. Proposal: reuse the generation lifecycle's existing timeout/recovery handling (`agentGenerationRecovery.ts`) and mark the discussion `failed` on unrecoverable turns.
