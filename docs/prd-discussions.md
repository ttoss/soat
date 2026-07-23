# PRD: Deep Thinking — Reasoning Engine & Discussions

> **Context for the remaining work.** All thinking is now a `Discussion` — a reusable
> config (`disc_`) whose invocations are `DiscussionRun`s (`drn_`), with `DiscussionParticipant`s
> (`dpt_`). Agents invoke a discussion mid-loop via a tool of type `discussion` and read the
> outcome synthesis as the tool result. The deliberation engine, the Discussions resource
> (thin synchronous MVP), and the removal of the old agent-side `reasoning` config have all
> shipped — see the Discussions module docs on the website for the current contract. Only the
> pending items below remain.

## Pending Work

| Component                                | Status         | Notes                                                                 |
| ---------------------------------------- | -------------- | --------------------------------------------------------------------- |
| Async run generate (`?async=true`)       | ❌ Not started | `in_progress` + poll for Discussion runs; depends on the session async/poll mechanism |
| `budget` guard                           | ❌ Not started | Optional cap on total internal completions per run                    |

## Phase 3 remainder — Async & Budget (deferred slice)

**Goal:** Deliberation is slow (N×M calls); make it non-blocking and cost-bounded.

Since Phase 5 removed the agent-side pipeline, both deferred items apply to **Discussion runs**,
not agent generations (they overlap with the "async run" item deferred from Phase 4).

**Acceptance criteria:**

- [ ] **Async run:** `POST /discussions/{discussion_id}/runs?async=true` returns `202` immediately
      with the run in `status: "pending"` (or `running`); `GET /discussions/runs/{run_id}` polls it
      to a terminal `completed`/`failed` state carrying the same inlined `outcome` as the
      synchronous path. Synchronous behavior unchanged when the flag is absent.
- [ ] **Budget guard:** an optional `budget` (max total completions per run) on the Discussion
      config, validated at write time to be ≤ the engine cap (`MAX_TOTAL_COMPLETIONS = 24`);
      a run that would exceed it stops deliberating and synthesizes from the turns taken so far
      (degrade, never fail). Consumed-completion count recorded on the run's trace metadata.

## Phase 4 remainder — Discussions Resource (deferred seams)

The thin MVP has shipped (synchronous `pending → running → completed/failed` runs, `round_robin`
turns, transcript persisted as a Conversation with Actor authorship + outcome Document, agent
invocation via the `discussion` tool type). The following seams were deliberately left clean for a
later phase:

- **Async run** (`?async=true`, `in_progress` + poll) — depends on the session async mechanism
  (shared with the Phase 3 deferred item above). The `discussion` tool type gains a non-blocking
  variant only after the agent-side async/poll mechanism exists; until then the tool stays synchronous.
- **Human participants** via `paused` + `required_action`, mirroring `executeHumanNode` in
  `orchestrationNodeExecutors.ts`.
- **`organizer_selects` turn policy** + organizer decision protocol (continue/end, next speaker) —
  prompt-based JSON with lenient parsing.
- **Real Agents with tools as participants** — the engine deliberately avoids tools; the
  Actor→participant seam makes this a later swap.
- **Orchestration `discussion` node type**; webhooks; cancellation/pause lifecycle states.

**Acceptance criteria (for the deferred slice, when picked up):**

- [ ] **Async run:** `POST /discussions/{discussion_id}/runs?async=true` returns `202` with a
      pollable run; `GET /discussions/runs/{run_id}` reaches `completed` with the same `outcome`
      contract as the synchronous path; the `discussion` tool type gains a non-blocking variant
      only after the agent-side async/poll mechanism exists (until then the tool stays synchronous).
- [ ] **Human participants:** a run with a human participant pauses in a `paused` status exposing a
      `required_action` payload (mirroring orchestration `executeHumanNode`); submitting the human
      turn resumes the round-robin; the human turn is persisted to the transcript Conversation
      attributed to the participant's Actor.
- [ ] **`organizer_selects` turn policy:** a `turn_policy` field on the Discussion config
      (`round_robin` default); with `organizer_selects`, an organizer completion returns
      prompt-based JSON (leniently parsed) choosing `{ next: <participant> }` or `{ end: true }`;
      malformed organizer output degrades to round-robin for that turn rather than failing the run.
- [ ] **Real-Agent participants:** a participant may reference an `agent_id` instead of an inline
      persona; its turns run through the agent (tools included) while transcript attribution stays
      Actor-based; the tool-less engine-branch path remains the default.
- [ ] **Orchestration `discussion` node:** an orchestration node type that invokes a discussion and
      exposes `outcome` (and run id) to downstream nodes via the existing `inputMapping` JSON Logic
      seam.
- [ ] Every shipped slice lands with the full module surface per `.claude/rules/modules.md`:
      OpenAPI + SDK/CLI regen, permissions, formation schema sync, docs, unit + MCP + smoke tests.
