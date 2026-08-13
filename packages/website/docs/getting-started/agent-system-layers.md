---
description: "The layers an agent system decomposes into — harness, loop, graph, ratchet — which SOAT module owns each one, why the graph should be the last thing you build, and why the ratchet — the layer that evaluates every change and keeps it from sliding backward — keeps the other three honest."
sidebar_position: 3
sidebar_label: Layers of an Agent System
title: The Layers of an Agent System
---

# The Layers of an Agent System

A common way to decompose an agent system splits it into three layers:

- the **harness** — the environment: what the agent can see, what it can do, what survives between runs, and what it is forbidden from touching;
- the **loop** — the feedback cycle: how work is checked, what evidence proves it succeeded, and when it stops;
- the **graph** — the flow: which step happens next, where work runs in parallel, and where a human signs off.

The decomposition is useful. The trap is reading it as three co-equal budgets. As
[_You Probably Don't Need a Graph_](https://ttoss.dev/blog/2026/08/08/you-probably-dont-need-a-graph)
argues, the investment order is not equal: **harness first, loop second, graph last — and
last frequently means never.**

It is also incomplete. All three layers describe a system *at rest* — what it can reach,
how it is checked, what runs next. None of them answers the question that decides whether
an agent is still good in six months, which is why this page adds a fourth:

- the **ratchet** — the mechanism of change: how a modification is evaluated against
  evidence and proven to be an improvement before it reaches production, and what stops
  the system from sliding backward.

SOAT is built around that order. This page maps each layer to the modules that own it, so
you know which part of the platform to reach for when a layer is the one failing.

| Layer       | The question it answers            | SOAT modules                                                                                                                                                                                            |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Harness** | What can this agent reach, and what is it forbidden? | [Tools](/docs/modules/tools), [Knowledge](/docs/modules/knowledge), [Documents](/docs/modules/documents), [Memories](/docs/modules/memories), [Sessions](/docs/modules/sessions), [IAM](/docs/modules/iam), [Secrets](/docs/modules/secrets), [Formations](/docs/modules/formations) |
| **Loop**    | What proves it did the job, and when does it stop? | [Agents](/docs/modules/agents) (`output_schema`, `max_steps`, `stop_conditions`), [Guardrails](/docs/modules/guardrails), [Approvals](/docs/modules/approvals), [Quotas](/docs/modules/quotas), [Usage](/docs/modules/usage), [Traces](/docs/modules/traces), [Exceptions](/docs/modules/exceptions) |
| **Graph**   | What is allowed to happen next?    | [Orchestrations](/docs/modules/orchestrations), [Workflows](/docs/modules/workflows), [Triggers](/docs/modules/triggers), [Discussions](/docs/modules/discussions)                                       |
| **Ratchet** | How does the system change, and what proves the change was an improvement? | [Evaluations](/docs/modules/evaluations), [agent versions](/docs/modules/agents#versioning-and-staged-rollout), the [approvals recurrence view](/docs/modules/approvals#recurrence-view), [Guardrails](/docs/modules/guardrails), [Formations](/docs/modules/formations) |

## Layer 1 — The harness

Most failures live here. An agent that cannot reach the right tool, works from stale
state, loses context between sessions, or holds permissions nobody scoped will not be
rescued by a better diagram. The harness is also where the cheapest wins are, and a lot of
them are deletion: a good harness is not crowded, it is precise.

### What the agent can do

[Tools](/docs/modules/tools) are first-class, project-scoped resources — not inline
definitions copy-pasted into each agent — so the same tool is shared, versioned, and fixed
in one place. Four types cover the surface:

| Type     | Reaches                                                        |
| -------- | -------------------------------------------------------------- |
| `http`   | Any HTTP endpoint                                              |
| `mcp`    | An external MCP server                                         |
| `client` | Client-side execution — the run pauses and resumes with the result |
| `soat`   | SOAT platform actions, including invoking another agent        |

Precision comes from narrowing, and [Agents](/docs/modules/agents) give you three dials
for it: `active_tool_ids` restricts which of the bound tools are live, `tool_choice` forces
or forbids a call, and `step_rules` changes both **per step** — so step 1 can see one tool
and step 2 a different one, instead of every tool being visible for the whole run. When an
agent misbehaves, shrinking these is usually a better first move than adding structure
around it.

### What the agent can see

Stale or missing context is the single most common environmental defect, and it is what
[Knowledge](/docs/modules/knowledge) exists for: one semantic search across a project's
[Documents](/docs/modules/documents) and [memory entries](/docs/modules/memories), ranked
by vector similarity and tagged by source. Set `knowledge_config` on the agent and
retrieval happens inside the run — the agent reads current project state rather than
whatever was pasted into its instructions.

Feeding it is the ingestion path: [Files](/docs/modules/files) →
[Documents](/docs/modules/documents) → [Embeddings](/docs/modules/embeddings), with
[Ingestion Rules](/docs/modules/ingestion-rules) turning uploads into searchable documents
automatically.

### What survives between runs

[Sessions](/docs/modules/sessions) are one user ↔ one agent with history handled for you;
[Conversations](/docs/modules/conversations) are the multi-party layer underneath;
[Actors](/docs/modules/actors) identify the participants. Durable facts — as opposed to
transcript — belong in [Memories](/docs/modules/memories), which the agent both reads
(through `knowledge_config`) and writes (through the built-in `write_memory` tool). See
[Agent with Persistent Memory](/docs/tutorials/memories-agent).

### What it must never touch

Overpermissioned agents are a harness defect, and SOAT scopes them at three independent
levels:

- **[IAM](/docs/modules/iam) and [Policies](/docs/modules/policies)** — the caller's
  `resource:Action` permissions, enforced identically across REST, MCP, CLI, and SDK.
- **`boundary_policy` on the agent** — a ceiling on which `soat` actions the agent itself
  may perform. Combined with the caller's own permissions, an agent can never be used to
  exceed them.
- **[Secrets](/docs/modules/secrets)** — provider credentials are encrypted and referenced
  by [AI Providers](/docs/modules/ai-providers), so no key ever travels in a request body
  or an agent's instructions.

### Making the harness reproducible

A harness that only exists because someone ran the right commands in the right order is
not a harness you can reason about. [Formations](/docs/modules/formations) declare agents,
tools, providers, knowledge, and their wiring as one deployable stack, so the environment
is a reviewable artifact rather than a state of the database. See the
[Formations tutorial](/docs/tutorials/formations).

## Layer 2 — The loop

The loop turns a capable agent into a reliable one. The rule worth memorizing: **do not
loop on confidence, loop on evidence.** "The agent says it is done" is not a stop
condition. Every loop needs three things — a success predicate, a budget, and an
escalation path — and SOAT has a primitive for each.

### A success predicate — evidence, not assertion

| Evidence                       | SOAT primitive                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| The output validates           | `output_schema` on the [agent](/docs/modules/agents) — the result is checked against a schema, not eyeballed                       |
| The action is permitted at call time | [Guardrails](/docs/modules/guardrails) classify each tool call from its **actual arguments**, deterministically, with no LLM in the evaluation path |
| The claim is grounded          | [Knowledge](/docs/modules/knowledge) results carry a `source_type` and a link to the document or memory entry they came from       |
| A branch condition holds       | A `condition` node in an [orchestration](/docs/modules/orchestrations), evaluated over JSON Logic                                  |

Guardrails are the sharpest of these, because they run **after the model produces the call
and before anything touches the outside world**, and compose stricter-wins across project,
agent, and tool scope. A class-C action does not execute — it becomes an approval item.
See [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).

### A budget — a loop with no ceiling is a cost leak

- `max_steps` and `stop_conditions` bound a single agent run.
- [Quotas](/docs/modules/quotas) fail closed on an aggregate cap — requests, tokens, or
  `cost_usd` — scoped to a project, API key, agent, or end user, and block with
  `429 QUOTA_EXCEEDED` before the generation starts.
- [Usage](/docs/modules/usage) meters every LLM call, orchestration node execution, API
  request, and stored byte, with thresholds that alert before a quota bites.
- Per-node `retry` in an orchestration takes `fixed` or `exponential` backoff with a delay
  ceiling, so a retry storm is bounded too.

See [Metering and Budgets](/docs/tutorials/metering-and-budgets) and
[Cap Spend per End User](/docs/tutorials/cap-spend-per-end-user).

### An escalation path — where the loop hands off

A loop that cannot escalate either spins or gives up silently.
[Approvals](/docs/modules/approvals) is the queue a risky action lands in: the proposed
action is frozen, the supporting evidence travels with it, and a hard expiry means an
un-decided item does not sit forever. A human approves, edits-then-approves, or rejects.
When something exhausts its retries, trips a guardrail tripwire, or expires without a
decision, the platform files an [Exception](/docs/modules/exceptions) — a triageable item
with severity and occurrence dedup, not a log line.

### Closing the loop needs to be observable

You cannot improve a loop you cannot see. [Traces](/docs/modules/traces) record every
reasoning step and tool call of a generation, and link parent to child when an agent
spawns a sub-agent, so a multi-agent run reconstructs as one tree.
[Generations](/docs/modules/generations) carry the per-run status and result,
[Activity](/docs/modules/activity) records what agents did autonomously, and the
[Audit Log](/docs/modules/audit-log) records what principals did to the platform. See
[Debug a Session Generation](/docs/tutorials/debug-session-generation-trace-history).

## Layer 3 — The graph, last

Explicit topology is workflow orchestration, and it predates language models by decades.
Nothing is wrong with it — but it is the layer whose most common failure mode is *existing
prematurely*. Reach for it when you observe one of these, and not before.

| Pain you actually observed                                     | What SOAT gives you                                                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A mandatory human gate** that must be enforced, not requested | An `approval` node in an [orchestration](/docs/modules/orchestrations), or `requires_approval` on a [workflow](/docs/modules/workflows) transition, which parks the state change itself   |
| **An audit requirement** — the path taken must be reconstructable | A `node_executions` record per attempt, a linked [trace](/docs/modules/traces), and append-only transition history with `principal_kind` on the workflow side                             |
| **Expensive parallel stages** needing deterministic joins       | Parallel execution rounds plus `activation_group` fan-in                                                                                                                                |
| **Durable resumption** — interrupted at hour six, restart at step nine | A durable queue with leases and a reaper, the `sleeping` / `awaiting_input` statuses, and resume/cancel on a run                                                                    |

These are properties of the **process**, not of the model — which is why they do not get
better as models improve, and why a graph is the right answer when they appear.

If you have decided you need one, the next question is which shape: an
[orchestration](/docs/modules/orchestrations) is a directed acyclic pipeline that runs and
ends; a [workflow](/docs/modules/workflows) is a state graph a task *lives* in and can
move backward through. They are not variants of each other, and they compose in both
directions. **[Choosing an Automation Model](./choosing-an-automation-model.md)** covers
the full comparison.

[Triggers](/docs/modules/triggers) start a graph on a cron schedule, an inbound webhook,
or on demand — without one, "the flow" is still a person running a command.

## Layer 4 — The ratchet

Where the loop asks *did this run succeed?*, the ratchet asks *did this change make the
agent better?* — a question about the distribution of runs, which no single run can
answer.

Every layer so far hands the system authority over something: the harness over what it can
*do*, the loop over how it is *checked*, the graph over what happens *next*. What no layer
covers is the thing a human still does by hand every week — **changing the system**. An
instruction gets reworded, a model is swapped, a tool is added, a correction is applied in
chat for the fourth time. Each of those is a production change with no verdict attached.

The ratchet is the mechanism that gives change a direction. Its shape is the same
everywhere: **produce a verdict from evidence, gate the change on the verdict, keep the
history append-only** so a bad change is recoverable rather than archaeological. Parts of
this layer are shipped today and parts are the platform's active build front — see
[Status](#status) below for the current state of each piece.

### It is not simply "after the graph"

Numbering it fourth is chronology, not priority. The ratchet acts *on* the other three
layers rather than stacking on top of them, and nothing in it requires a graph: an eval
suite over one agent is the most valuable thing most teams are missing, and it is worth
building **before** a topology, not after. The order that holds in practice is: build the
harness, close the loop, **ratchet the loop as soon as it produces evidence you trust**,
and add a graph only when a process pain demands one.

| Pain you actually observed                                       | What SOAT gives you                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **You changed an instruction, model, or tool** and cannot say whether it got better | An [evaluation](/docs/modules/evaluations) — a dataset of cases, scorers that produce a number, and a run compared against a named baseline                    |
| **A regression is live** and nobody can name what changed        | Append-only [agent versions](/docs/modules/agents#versioning-and-staged-rollout), with the served version stamped on every generation as `agent_version`                         |
| **Promotion is a judgment call made under deadline**             | A staged [release](/docs/modules/agents#staged-rollout) (stable/canary split) whose promotion is gated on an eval verdict rather than a hunch                                    |
| **A human keeps making the same correction**                     | The approvals [recurrence view](/docs/modules/approvals#recurrence-view) rolls up repeated rejections with their reasons — the prompt to encode a [guardrail](/docs/modules/guardrails) `deny` that stops the pattern upstream |
| **Guidance was added to an agent and nobody knows if it works**   | Instructions are soft context, so efficacy is an eval question: run the regression set with the wording changed and without it, and compare against the baseline                  |

### A verdict, not an opinion

[Evaluations](/docs/modules/evaluations) is the module that turns "it feels better" into a
number. A project-scoped **dataset** holds the cases, **scorers** grade each output —
deterministic ones (exact match, substring, JSON Logic, schema validation) and an LLM
judge where the criterion is genuinely fuzzy — and a **run** executes the real agent
against every item, so the verdict reflects the agent's true instructions, tools, model,
and knowledge rather than a mock of them. A run compared against a named baseline yields
per-scorer deltas and a pass/fail verdict, and every result links back to its
[generation](/docs/modules/generations) and [trace](/docs/modules/traces) for drill-down.

Two consequences worth planning for. Eval runs are real generations, so they cost real
money — which is why eval spend is attributed separately from production spend in
[usage](/docs/modules/usage) rollups. And agents are stochastic, so a red run may be
variance rather than regression: judge aggregates over a dataset, not single items, and set
a pass threshold below `1.0`.

### Change that cannot slide backward

[Agent versions](/docs/modules/agents#versioning-and-staged-rollout) are the ratchet's
teeth. Every write that changes an agent's config archives the new config and increments
`version`; a write that changes nothing creates no version. Restore does not rewind the
counter — it copies an archived config forward as a *new* version, so history stays
append-only and "undo the undo" is just another restore. Because every generation records
the `agent_version` that served it, a behavior change found in a trace attributes to a
specific config instead of a date range.

A [staged release](/docs/modules/agents#staged-rollout) splits traffic deterministically
between a stable and a canary version, which is what makes a verdict actionable: the
canary accumulates real evidence, and promotion becomes a decision about a measurement
rather than about a deadline.

### Corrections that outlive the conversation

The other half of adaptation is human corrections, and the platform already persists their
raw material: every [approval](/docs/modules/approvals) rejection carries its reason, every
edit-then-approve carries the argument diff, and re-proposals thread onto the item they
recur from. The shipped [recurrence view](/docs/modules/approvals#recurrence-view) rolls
that up into "this correction has happened four times" — grouped by exact key, with no new
models and no LLM in the path.

That surface is deliberately the *deterministic* slice: it tells you a correction recurs,
and leaves the judgment about what to do with it to a human. The distinction that decides
where any piece of guidance belongs is worth internalizing — **[memories](/docs/modules/memories)
are facts the agents learn about the world; a correction is doctrine about how the agent
should act**, and doctrine has two homes, not one:

- **Hard** — a [guardrail](/docs/modules/guardrails) `deny`, which refuses the action
  upstream so it never reaches the queue again. This is the right home whenever a constraint
  must *never* be violated, and recurring rejections are exactly the signal for it.
- **Soft** — the agent's `instructions`, which the model is expected but not forced to
  follow, and which [agent versions](/docs/modules/agents#versioning-and-staged-rollout)
  archive on every write, so the reworded guidance is attributable and reversible.

Soft guidance is where the ratchet's two halves meet: whether a wording change actually
improved anything is not a judgment, it is an eval.

### What the ratchet must never do

Promote by itself. It is tempting to let the system turn a recurring correction into a
standing instruction automatically, and it is an unforced error class: free-text
corrections are ambiguous, occasionally wrong, and permanent once they are in every
prompt. SOAT's stance is that the platform owns the *queue*, the *recurrence signal*, and
the *verdict*, and a human owns the judgment — rewording an instruction, encoding a
guardrail `deny`, and promoting a canary all stay human-gated decisions made against
evidence the platform assembled.

This is also where the layers stop being a purely technical progression. A bad objective
looks like flawless execution in every trace, so the reading habit that works below —
"read the trace" — is not sufficient here. Deciding *what the system should be optimizing*
is not a layer SOAT automates.

### Status

The ratchet is the platform's active build front, so parts of it are shipped and parts are
planned. Where a page below is marked coming soon, the concept is designed and the surface
is not built yet.

| Piece                                                                  | State                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Agent versions](/docs/modules/agents#versioning-and-staged-rollout) — history, restore, canary split, served-version stamping | Shipped — see [Agent Versioning and Canary Rollout](/docs/tutorials/agent-versioning-and-canary-rollout) |
| [Approvals recurrence view](/docs/modules/approvals#recurrence-view)   | Shipped                                                                                        |
| [Evaluations](/docs/modules/evaluations) — datasets, scorers, runs, baselines | Shipped                                                                                  |
| [Eval-gated promotion](/docs/modules/agents#eval-gated-promotion) of a canary release | Shipped                                                                         |
| [Memories](/docs/modules/memories) forgetting — importance scoring, recency blending, compaction | Coming soon                                                                    |

## Diagnose before you build

The most valuable thing the layer framing gives you is a diagnostic. Attribute the
failure to a layer *before* changing anything — and do it in order, because environment
defects impersonate the other three. An agent starved of context produces inconsistent
output that reads like a verification problem and erratic sequencing that reads like a
topology problem.

| Symptom                                                  | Layer at fault | Where to look in SOAT                                                                                                     |
| -------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The agent **cannot operate** — wrong tool, stale answers, forgets the user | Harness        | [Tools](/docs/modules/tools) and `active_tool_ids`; `knowledge_config` and [Knowledge](/docs/modules/knowledge); [Sessions](/docs/modules/sessions) and [Memories](/docs/modules/memories) |
| It **almost works but is unreliable** — right sometimes, unverifiable, or runs away | Loop           | `output_schema`, `max_steps`, [Guardrails](/docs/modules/guardrails), [Quotas](/docs/modules/quotas) — read the [Trace](/docs/modules/traces) first |
| It **did something it should not have been able to do**  | Harness        | [Policies](/docs/modules/policies), the agent's `boundary_policy`, [Audit Log](/docs/modules/audit-log)                  |
| **Each step is fine but the process is unmanageable** — no gate, no resume, no record of the path | Graph          | [Orchestrations](/docs/modules/orchestrations) or [Workflows](/docs/modules/workflows)                                     |
| **It was fine last month** — a change made it worse, nobody can say which one, and the same correction keeps being applied by hand | Ratchet        | [Agent versions](/docs/modules/agents#versioning-and-staged-rollout) and the `agent_version` on the generation; [Evaluations](/docs/modules/evaluations); the [approvals recurrence view](/docs/modules/approvals#recurrence-view) |

## Where to start

1. **Build the harness.** One agent, an [AI provider](/docs/modules/ai-providers), the
   few tools it genuinely needs, and `knowledge_config` pointed at real project content.
   The [Quick Start](./quick-start.md) gets you here.
2. **Close the loop.** Add an `output_schema` so success is checked rather than claimed, a
   `max_steps` and a [quota](/docs/modules/quotas) so it cannot run away, a
   [guardrail](/docs/modules/guardrails) on anything that touches the outside world, and
   read the [traces](/docs/modules/traces).
3. **Fit the ratchet.** Version the agent so every change is attributable, roll a
   significant change out as a canary rather than in place, and stand up a small
   [evaluation](/docs/modules/evaluations) dataset from real traffic — a dozen cases you
   would be embarrassed to regress is enough to start.
4. **Add a graph only when a specific pain unlocks it** — a human gate, an audit
   requirement, a parallel join, or durable resume. Then go to
   [Choosing an Automation Model](./choosing-an-automation-model.md).

The differentiator in production has rarely been the model, and it is not the diagram
either. It is whether the agent can reach what it needs, whether anything in the system
can prove it did the job, and whether the next change can be shown to be an improvement
before it reaches anyone.
