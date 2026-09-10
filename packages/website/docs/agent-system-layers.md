---
description: "The layers an agent system decomposes into — harness, loop, graph, ratchet — which SOAT module owns each one, why the graph should be the last thing you build, and how the layers map onto autonomy maturity grades."
sidebar_position: 2
sidebar_label: Layers of an Agent System
title: The Layers of an Agent System
---

# The Layers of an Agent System

An agent system decomposes into four layers:

- the **harness** — what the agent can see and do, what survives between runs, what it must not touch;
- the **loop** — how work is checked, what evidence proves success, when it stops;
- the **graph** — what happens next, what runs in parallel, where a human signs off;
- the **ratchet** — how a change is proven an improvement before it reaches production.

Investment order, per [_You Probably Don't Need a Graph_](https://ttoss.dev/blog/2026/08/08/you-probably-dont-need-a-graph): **harness first, loop second, graph last, and last frequently means never.** The ratchet acts on the other three and belongs as soon as the loop produces evidence you trust.

| Layer       | The question it answers            | SOAT modules                                                                                                                                                                                            |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Harness** | What can this agent reach, and what is it forbidden? | [Tools](/docs/modules/tools), [Knowledge](/docs/modules/knowledge), [Documents](/docs/modules/documents), [Memories](/docs/modules/memories), [Sessions](/docs/modules/sessions), [IAM](/docs/modules/iam), [Secrets](/docs/modules/secrets), [Formations](/docs/modules/formations) |
| **Loop**    | What proves it did the job, and when does it stop? | [Agents](/docs/modules/agents) (`output_schema`, `max_steps`, `stop_conditions`), [Guardrails](/docs/modules/guardrails), [Approvals](/docs/modules/approvals), [Quotas](/docs/modules/quotas), [Usage](/docs/modules/usage), [Traces](/docs/modules/traces), [Exceptions](/docs/modules/exceptions) |
| **Graph**   | What is allowed to happen next?    | [Orchestrations](/docs/modules/orchestrations), [Workflows](/docs/modules/workflows), [Triggers](/docs/modules/triggers)                                       |
| **Ratchet** | How does the system change, and what proves the change was an improvement? | [Evaluations](/docs/modules/evaluations), [agent versions](/docs/modules/agents#versioning-and-staged-rollout), the [approvals recurrence view](/docs/modules/approvals#recurrence-view), [Guardrails](/docs/modules/guardrails), [Formations](/docs/modules/formations) |

## Layer 1 — The harness

Most failures live here: wrong tool, stale state, lost context, unscoped permissions.

### What the agent can do

[Tools](/docs/modules/tools) are project-scoped resources shared across agents. Four types:

| Type     | Reaches                                                        |
| -------- | -------------------------------------------------------------- |
| `http`   | Any HTTP endpoint                                              |
| `mcp`    | An external MCP server                                         |
| `client` | Client-side execution — the run pauses and resumes with the result |
| `builtin`   | SOAT platform actions, including invoking another agent        |

[Agents](/docs/modules/agents) narrow the surface with three dials: `active_tool_ids` restricts which bound tools are live, `tool_choice` forces or forbids a call, and `step_rules` changes both **per step**. Shrink these before adding structure.

### What the agent can see

[Knowledge](/docs/modules/knowledge) is one semantic search across a project's [Documents](/docs/modules/documents) and [memory entries](/docs/modules/memories), ranked by vector similarity and tagged by source. `knowledge_config` on the agent runs retrieval inside the run.

Ingestion path: [Files](/docs/modules/files) → [Documents](/docs/modules/documents) → [Embeddings](/docs/modules/embeddings); [Ingestion Rules](/docs/modules/ingestion-rules) turn uploads into searchable documents automatically.

### What survives between runs

[Sessions](/docs/modules/sessions): one user ↔ one agent with managed history. [Conversations](/docs/modules/conversations): the multi-party layer underneath. [Actors](/docs/modules/actors): the participants. Durable facts belong in [Memories](/docs/modules/memories), read through `knowledge_config` and written through the built-in `write_memory` tool. See [Agent with Persistent Memory](/docs/tutorials/memories-agent).

### What it must never touch

Three independent scopes:

- **[IAM](/docs/modules/iam) and [Policies](/docs/modules/policies)** — the caller's `resource:Action` permissions, enforced identically across REST, MCP, CLI, and SDK.
- **`boundary_policy` on the agent** — a ceiling on which `builtin` actions the agent may perform; combined with the caller's permissions, an agent can never exceed them.
- **[Secrets](/docs/modules/secrets)** — encrypted provider credentials referenced by [AI Providers](/docs/modules/ai-providers); no key travels in a request body or instructions.

### Making the harness reproducible

[Formations](/docs/modules/formations) declare agents, tools, providers, knowledge, and their wiring as one deployable stack. See the [Formations tutorial](/docs/tutorials/formations).

## Layer 2 — The loop

Every loop needs a success predicate, a budget, and an escalation path.

### A success predicate — evidence, not assertion

| Evidence                       | SOAT primitive                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| The output validates           | `output_schema` on the [agent](/docs/modules/agents) — the result is checked against a schema                       |
| The action is permitted at call time | [Guardrails](/docs/modules/guardrails) classify each tool call from its **actual arguments**, deterministically, with no LLM in the evaluation path |
| The claim is grounded          | [Knowledge](/docs/modules/knowledge) results carry a `source_type` and a link to the document or memory entry they came from       |
| A branch condition holds       | A `condition` node in an [orchestration](/docs/modules/orchestrations), evaluated over JSON Logic                                  |

Guardrails run after the model produces the call and before anything touches the outside world, composing stricter-wins across project, agent, and tool scope. A class-C action becomes an approval item instead of executing. See [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).

### A budget — a loop with no ceiling is a cost leak

- `max_steps` and `stop_conditions` bound a single agent run.
- [Quotas](/docs/modules/quotas) fail closed on an aggregate cap (requests, tokens, or `cost_usd`) scoped to a project, API key, agent, or end user, blocking with `429 QUOTA_EXCEEDED` before the generation starts.
- [Usage](/docs/modules/usage) meters every LLM call, orchestration node execution, API request, and stored byte, with thresholds that alert before a quota bites.
- Per-node `retry` in an orchestration takes `fixed` or `exponential` backoff with a delay ceiling.

See [Metering and Budgets](/docs/tutorials/metering-and-budgets) and [Cap Spend per End User](/docs/tutorials/cap-spend-per-end-user).

### An escalation path — where the loop hands off

[Approvals](/docs/modules/approvals) is the queue a risky action lands in: the action is frozen, evidence travels with it, a hard expiry bounds it. A human approves, edits-then-approves, or rejects. Exhausted retries, a guardrail tripwire, or expiry without a decision file an [Exception](/docs/modules/exceptions): a triageable item with severity and occurrence dedup.

### Closing the loop needs to be observable

[Traces](/docs/modules/traces) record every reasoning step and tool call, linking parent to child so a multi-agent run reconstructs as one tree. [Generations](/docs/modules/generations) carry per-run status and result, [Activity](/docs/modules/activity) what agents did autonomously, the [Audit Log](/docs/modules/audit-log) what principals did to the platform. See [Debug a Session Generation](/docs/tutorials/debug-session-generation-trace-history).

## Layer 3 — The graph, last

Reach for a graph when you observe one of these:

| Pain you actually observed                                     | What SOAT gives you                                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A mandatory human gate** that must be enforced, not requested | An `approval` node in an [orchestration](/docs/modules/orchestrations), or `requires_approval` on a [workflow](/docs/modules/workflows) transition, which parks the state change itself   |
| **An audit requirement** — the path taken must be reconstructable | A `node_executions` record per attempt, a linked [trace](/docs/modules/traces), and append-only transition history with `principal_kind` on the workflow side                             |
| **Expensive parallel stages** needing deterministic joins       | Parallel execution rounds plus `activation_group` fan-in                                                                                                                                |
| **Durable resumption** — interrupted at hour six, restart at step nine | A durable queue with leases and a reaper, the `sleeping` / `awaiting_input` statuses, and resume/cancel on a run                                                                    |

These are properties of the process, not the model, so they do not improve as models do.

Two shapes: an [orchestration](/docs/modules/orchestrations) is a directed acyclic pipeline that runs and ends; a [workflow](/docs/modules/workflows) is a state graph a task lives in and can move backward through. They compose in both directions: **[Choosing an Automation Model](./advanced/choosing-an-automation-model.md)**.

[Triggers](/docs/modules/triggers) start a graph on a cron schedule, an inbound webhook, or on demand.

## Layer 4 — The ratchet

The loop asks *did this run succeed?*; the ratchet asks *did this change make the agent better?* A reworded instruction, a swapped model, an added tool, a correction applied in chat for the fourth time: each is a production change with no verdict attached.

The ratchet's shape: **produce a verdict from evidence, gate the change on the verdict, keep the history append-only.** Current state of each piece: [Status](#status).

### It is not simply "after the graph"

The ratchet acts on the other three layers and needs no graph. Order in practice: build the harness, close the loop, ratchet the loop as soon as it produces evidence you trust, add a graph only when a process pain demands one.

| Pain you actually observed                                       | What SOAT gives you                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **You changed an instruction, model, or tool** and cannot say whether it got better | An [evaluation](/docs/modules/evaluations) — a dataset of cases, scorers that produce a number, and a run compared against a named baseline                    |
| **A regression is live** and nobody can name what changed        | Append-only [agent versions](/docs/modules/agents#versioning-and-staged-rollout), with the served version stamped on every generation as `agent_version`                         |
| **Promotion is a judgment call made under deadline**             | A staged [release](/docs/modules/agents#staged-rollout) (stable/canary split) whose promotion is gated on an eval verdict                                    |
| **A human keeps making the same correction**                     | The approvals [recurrence view](/docs/modules/approvals#recurrence-view) rolls up repeated rejections with their reasons — the prompt to encode a [guardrail](/docs/modules/guardrails) `deny` that stops the pattern upstream |
| **Guidance was added to an agent and nobody knows if it works**   | Instructions are soft context, so efficacy is an eval question: run the regression set with and without the wording and compare against the baseline                  |

### A verdict, not an opinion

[Evaluations](/docs/modules/evaluations): a project-scoped **dataset** holds the cases; **scorers** grade each output (deterministic: exact match, substring, JSON Logic, schema validation; an LLM judge for fuzzy criteria; or [your own algorithm as a tool](/docs/modules/evaluations#custom-scorers-tool)); a **run** executes the real agent (its true instructions, tools, model, and knowledge) against every item. Compared against a named baseline it yields per-scorer deltas and a pass/fail verdict; every result links to its [generation](/docs/modules/generations) and [trace](/docs/modules/traces).

Eval runs are real generations; eval spend is attributed separately from production spend in [usage](/docs/modules/usage) rollups. Agents are stochastic: judge aggregates over a dataset, not single items, and set a pass threshold below `1.0`.

### Change that cannot slide backward

[Agent versions](/docs/modules/agents#versioning-and-staged-rollout): every write that changes an agent's config archives it and increments `version`; a no-op write creates no version. Restore copies an archived config forward as a *new* version. Every generation records the `agent_version` that served it.

A [staged release](/docs/modules/agents#staged-rollout) splits traffic deterministically between a stable and a canary version; the canary accumulates real evidence before promotion.

### Corrections that outlive the conversation

Every [approval](/docs/modules/approvals) rejection carries its reason, every edit-then-approve carries the argument diff, and re-proposals thread onto the item they recur from. The [recurrence view](/docs/modules/approvals#recurrence-view) rolls that up by exact key, with no LLM in the path; it reports that a correction recurs and leaves the judgment to a human.

[Memories](/docs/modules/memories) are facts the agents learn about the world; a correction is doctrine about how the agent should act. Doctrine has two homes:

- **Hard** — a [guardrail](/docs/modules/guardrails) `deny`, refusing the action upstream. For constraints that must never be violated; recurring rejections are the signal.
- **Soft** — the agent's `instructions`, which the model is expected but not forced to follow, archived by [agent versions](/docs/modules/agents#versioning-and-staged-rollout) on every write.

Whether a wording change improved anything is an eval, not a judgment.

### What the ratchet must never do

Promote by itself. The platform owns the *queue*, the *recurrence signal*, and the *verdict*; a human owns the judgment: rewording an instruction, encoding a guardrail `deny`, and promoting a canary stay human-gated.

The pieces for a self-modifying loop exist: a [`builtin` tool](/docs/modules/tools#builtin) can expose `update-agent`, `update-guardrail`, `set-agent-release`, `start-eval-run`, `promote-agent-release`, so an agent with those actions and a permitting credential can propose changes to its own definitions, with [eval-gated promotion](/docs/modules/agents#eval-gated-promotion) as the deterministic brake. Two boundaries mark where platform enforcement ends:

- **The promotion gate verifies evidence; it does not produce it.** `promote` fails closed (`409 PROMOTION_GATE_UNMET`) until a passing run pinned to the canary exists; running the eval is an explicit call outside the gate, only as trustworthy as its scorers and dataset.
- **`boundary_policy` ceilings only `builtin` actions.** An agent reaching the platform through an `http` or `mcp` tool is outside that boundary; only a [guardrail](/docs/modules/guardrails) at tool, agent, or project scope reaches those calls.

Deciding what the system should optimize is not a layer SOAT automates.

### Status

Pieces marked coming soon are designed but not built.

| Piece                                                                  | State                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Agent versions](/docs/modules/agents#versioning-and-staged-rollout) — history, restore, canary split, served-version stamping | Shipped — see [Agent Versioning and Canary Rollout](/docs/tutorials/agent-versioning-and-canary-rollout) |
| [Approvals recurrence view](/docs/modules/approvals#recurrence-view)   | Shipped                                                                                        |
| [Evaluations](/docs/modules/evaluations) — datasets, scorers, runs, baselines | Shipped                                                                                  |
| [Eval-gated promotion](/docs/modules/agents#eval-gated-promotion) of a canary release | Shipped                                                                         |
| [Memories](/docs/modules/memories) forgetting — importance scoring, recency blending, compaction | Coming soon                                                                    |

## Layers are concerns, not autonomy levels

Every agent system has all four layers. **Delegation** (maturity grades 0–4) is a separate axis: how much runs without a human in the step. Moving up the ladder never adds a layer; it changes which primitives carry each one.

| Delegation grade | What runs without a human | SOAT primitives |
| --- | --- | --- |
| **0 — Deterministic tooling** | Everything — no model in the path | [`pipeline`](/docs/modules/tools#pipeline) and [`http`](/docs/modules/tools#http) tools, tool-only [orchestrations](/docs/modules/orchestrations), [workflow](/docs/modules/workflows) guards, [triggers](/docs/modules/triggers) — all JSON Logic, no LLM |
| **1 — Assistant** | Nothing — the model reads and proposes, the application executes | [Agents](/docs/modules/agents) with [`client` tools](/docs/modules/tools#client) (the run pauses on `requires_action`), `knowledge_config`, [sessions](/docs/modules/sessions) |
| **2 — Supervised autonomy** | Each action a policy clears, per call | [Guardrail action classes](/docs/modules/guardrails#action-classes) A/B/C/D, [approvals](/docs/modules/approvals), [quotas](/docs/modules/quotas) |
| **3 — End-to-end automation** | Whole flows, agents invoking agents | [Orchestrations](/docs/modules/orchestrations), [workflows](/docs/modules/workflows), [nested agent calls](/docs/modules/agents#nested-agent-calls), [triggers](/docs/modules/triggers) |
| **4 — Self-modification** | The system changes its own definitions | A composition, not a shipped mode — see [What the ratchet must never do](#what-the-ratchet-must-never-do) |

Grades 0–2 are one mechanism: a guardrail's [action classes](/docs/modules/guardrails#action-classes) apply this dial per tool call (class A is grade 0/1, class B grade 2 with a deterministic guard, class C hands the call to a human), and `default_class` falling back to **C** means an unclassified call never gains autonomy by accident.

## Diagnose before you build

Attribute a failure to a layer before changing anything, in this order: harness defects impersonate the other three.

| Symptom                                                  | Layer at fault | Where to look in SOAT                                                                                                     |
| -------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The agent **cannot operate** — wrong tool, stale answers, forgets the user | Harness        | [Tools](/docs/modules/tools) and `active_tool_ids`; `knowledge_config` and [Knowledge](/docs/modules/knowledge); [Sessions](/docs/modules/sessions) and [Memories](/docs/modules/memories) |
| It **almost works but is unreliable** — right sometimes, unverifiable, or runs away | Loop           | `output_schema`, `max_steps`, [Guardrails](/docs/modules/guardrails), [Quotas](/docs/modules/quotas) — read the [Trace](/docs/modules/traces) first |
| It **did something it should not have been able to do**  | Harness        | [Policies](/docs/modules/policies), the agent's `boundary_policy`, [Audit Log](/docs/modules/audit-log)                  |
| **Each step is fine but the process is unmanageable** — no gate, no resume, no record of the path | Graph          | [Orchestrations](/docs/modules/orchestrations) or [Workflows](/docs/modules/workflows)                                     |
| **It was fine last month** — a change made it worse, nobody can say which one, and the same correction keeps being applied by hand | Ratchet        | [Agent versions](/docs/modules/agents#versioning-and-staged-rollout) and the `agent_version` on the generation; [Evaluations](/docs/modules/evaluations); the [approvals recurrence view](/docs/modules/approvals#recurrence-view) |

## Where to start

1. **Build the harness.** One agent, an [AI provider](/docs/modules/ai-providers), the few tools it needs, `knowledge_config` on real project content. [Quick Start](./getting-started/quick-start.md).
2. **Close the loop.** `output_schema`, `max_steps`, a [quota](/docs/modules/quotas), a [guardrail](/docs/modules/guardrails) on anything touching the outside world; read the [traces](/docs/modules/traces).
3. **Fit the ratchet.** Version the agent, roll significant changes out as a canary, and build a small [evaluation](/docs/modules/evaluations) dataset from real traffic (a dozen cases is enough to start).
4. **Add a graph only when a specific pain unlocks it**: a human gate, an audit requirement, a parallel join, or durable resume. Then [Choosing an Automation Model](./advanced/choosing-an-automation-model.md).
