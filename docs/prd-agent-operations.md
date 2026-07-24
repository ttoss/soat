# PRD: Agent Operations on Formations (Overview)

> Umbrella document for a set of related PRDs that together make a single
> [Formation](../packages/website/docs/modules/formations.md) able to declare a
> complete, **operating** team of agents — schedules, guardrails, approval
> queues, and cost meters — not just the static agent
> topology. Each capability has its own PRD; this page holds the shared goals,
> the gap analysis, and the end-state template they add up to.

| Capability                                | PRD                                                    |
| ----------------------------------------- | ------------------------------------------------------ |
| Queue-backed run execution                | [prd-orchestration-queue.md](./prd-orchestration-queue.md) |
| Approval & exception queues, activity feed | [prd-approvals.md](./prd-approvals.md)                 |
| Usage metering                            | [prd-usage-metering.md](./prd-usage-metering.md)       |
| Feedback loop → learned rules             | [prd-learned-rules.md](./prd-learned-rules.md)         |

## Problem Statement

Formations can already deploy a full agent stack declaratively: providers,
agents, tools, memories, secrets, DAG orchestrations with human nodes, webhooks
— one template, one stack, parameterized per project. What they deploy today is
**passive**: nothing runs until a caller starts an orchestration run or sends a
message.

Teams building always-on, production agent operations (recurring analysis
cycles, autonomous actions against external systems, human sign-off on risky
actions, per-project cost accounting) currently have to bolt an external
scheduler, an approval workflow, a policy layer, and a metering pipeline onto
SOAT. Those are exactly the pieces that make an agent deployment *operate*
rather than merely *exist*, and they belong in the platform.

## Goals

1. A single formation template can declare a complete, operating agent stack:
   agents and tools **plus schedules, guardrail policies, approval queues, and
   cost meters**.
2. Cycles run proactively on schedules, durably, surviving redeploys.
3. Every mutation-capable tool call passes through a deterministic (non-LLM)
   guardrail evaluator with fail-closed semantics.
4. Approvals and exceptions are first-class, queryable product state — not
   ephemeral pauses inside a DAG run.
5. Per-run cost accounting is billing-grade: append-only, idempotent under
   retries, attributable to `project → run → node → agent`.
6. Human corrections are capturable as candidate rules and promotable into
   scoped learned rules that the consuming application injects into the next
   run (context composition is the app's responsibility, not the platform's).

## Non-Goals

- Billing itself. SOAT meters usage; converting meters into invoices, credits,
  or customer-facing billing units happens downstream in the consuming product.
- Product surfaces (dashboards, chat apps, messaging integrations). SOAT
  exposes queues, feeds, and events via REST/MCP/webhooks; surfaces stay thin
  clients.
- Curation UIs for learned rules — consumers of the API.
- A general-purpose workflow engine. Durable execution remains scoped to DAG
  orchestrations: no sub-workflow signals beyond approval resolution, no
  arbitrary event triggers (webhook-receive nodes already cover inbound waits).

## Gap Analysis

What SOAT already covers (and these PRDs do **not** re-specify): agents, tools
(HTTP/MCP/client/SOAT), memories with dedup/merge, secrets, DAG orchestrations
with human/delay/poll/loop/condition nodes, **durable background run execution
with checkpoint-based crash recovery and per-node retry/backoff** (see
[orchestrations.md → Durable Background Execution](../packages/website/docs/modules/orchestrations.md#durable-background-execution)),
**cron-shaped [schedule triggers](../packages/website/docs/modules/triggers.md)**
that start runs without a caller, **[guardrail policies](../packages/website/docs/modules/guardrails.md)**
with deterministic action-class evaluation, project tenancy, caller ∩ agent
permission intersection, webhooks with signed deliveries, and Formations as the
declarative deploy layer.

| #  | Gap                                    | Requirement                                                        | SOAT today                                                                                                      |
| -- | -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| G2 | Queue-backed runs                       | Worker pool, at-least-once + idempotency, concurrency limits        | Durable background execution, lease/reaper recovery, and retries **exist**; no queue abstraction, no idempotency keys, no concurrency limits |
| G3 | Approval & exception queues             | Persistent queue with evidence + expiry; manage-by-exception        | `human` nodes pause runs (`awaiting_input`); no persistent queue, no expiry, no severity routing                   |
| G5 | Billing-grade cost metering             | Per-run token/cost accounting, idempotent under retries             | Per-**generation** and per-**run** metering + versioned price book **exist** (`UsageEvent`/`UsageComponent`/`PriceBook`, per-generation + per-run receipt, run roll-up, #562); grouped aggregation and non-LLM meter types (compute/storage/requests) do not — see [prd-usage-metering.md](./prd-usage-metering.md) |
| G6 | Feedback loop → learned rules           | Candidate rule → curation → promotion, scoped                       | Memory dedup/merge stores facts; no rule lifecycle                                                                 |

## End State: One Template, One Operating Stack

With the remaining PRDs shipped (on top of the already-shipped schedule
triggers and guardrail modules), a single template expresses an operating
stack. Canonical end-state example (node and resource properties follow the
child PRDs: the `approval` node schema from
[prd-approvals.md](./prd-approvals.md#the-approval-node--template-schema), the
`schedule` trigger from the [Triggers module](../packages/website/docs/modules/triggers.md), and the
`action_classes` policy from [guardrails](../packages/website/docs/modules/guardrails.md)):

```yaml
parameters:
  OpenAiApiKey: { type: string, use_previous_value: true }
  ActionClassesDoc: { type: string }
  DailyCycleCron: { type: string, default: '0 8 * * *' }
  ExternalMcpUrl: { type: string }

resources:
  ProviderKey:
    type: secret
    properties:
      name: openai-api-key
      value: { param: OpenAiApiKey }

  Provider:
    type: ai_provider
    properties:
      name: openai
      provider: openai
      default_model: gpt-4o
      secret_id: { ref: ProviderKey }

  ActionPolicy:
    type: policy
    properties:
      name: ops-action-classes
      kind: action_classes
      document: { param: ActionClassesDoc }

  ExternalTools:
    type: tool
    properties:
      name: external-ops
      type: mcp
      mcp:
        url: { param: ExternalMcpUrl }

  Analyst:
    type: agent
    properties:
      name: analyst
      ai_provider_id: { ref: Provider }
      instructions: >-
        Analyze the project's daily data and produce findings with
        supporting evidence.

  Operator:
    type: agent
    properties:
      name: operator
      ai_provider_id: { ref: Provider }
      instructions: >-
        Turn findings into one concrete proposed action against the
        external system, with predicted impact.
      tool_ids: [{ ref: ExternalTools }]
      guardrail_policy_id: { ref: ActionPolicy }

  DailyFlow:
    type: orchestration
    properties:
      name: daily-cycle
      nodes:
        - id: analyze
          type: agent
          agent_id: { ref: Analyst }
          input_mapping: { prompt: { var: 'cycle' } }
          output_mapping: { content: state.findings }
        - id: propose
          type: agent
          agent_id: { ref: Operator }
          input_mapping: { prompt: { var: 'findings' } }
          output_mapping: { content: state.proposal }
        - id: sign_off
          type: approval
          tool_id: { ref: ExternalTools }
          arguments: { action: { var: 'proposal' } }
          expires_in: 86400 # seconds
          instructions: Review the proposed external change before it executes.
          reasoning: { var: 'findings' }
          output_mapping: { result: state.executed }
        - id: report
          type: agent
          agent_id: { ref: Analyst }
          input_mapping: { prompt: { var: 'executed' } }
          output_mapping: { content: state.report }
      edges:
        - { from: analyze, to: propose }
        - { from: propose, to: sign_off }
        - { from: sign_off, to: report, condition: approved }
        # no `rejected`/`expired` edge: the run ends there; expiry files an
        # `approval_expired` exception (the approval node's default routing)

  DailyCycle:
    type: schedule
    properties:
      name: daily-cycle
      orchestration_id: { ref: DailyFlow }
      cron: { param: DailyCycleCron }
      timezone: America/Sao_Paulo
      overlap_policy: skip
      input: { cycle: daily }

  AppWebhook:
    type: webhook
    properties:
      name: app-events
      url: https://app.example.com/hooks/soat
      events:
        - approvals.created
        - approvals.expired
        - exceptions.created
        - usage.threshold_crossed

outputs:
  orchestration_id: { ref: DailyFlow }
  schedule_id: { ref: DailyCycle }
```

One formation deploy per project (template + project parameters) yields a
stack that runs on schedule, executes safe actions autonomously, queues risky
ones for approval, meters every LLM call, and learns from every human
correction.

## Suggested Build Order

Ordered so that a read-only analysis cycle works end to end first (zero
side-effect risk while the pipeline hardens):

| Step | Scope                                                            | Unblocks                                                     |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | G2 queue driver (Postgres) + idempotency keys (schedule triggers already start runs) | A daily read-only cycle end to end, surviving restarts        |
| 2    | G3 approval/exception queues + webhook events + activity feed      | Manage-by-exception surface; class C flow                     |
| 3    | G5 metering (guardrail action-class evaluation already ships)      | Autonomous class-B actions with cost visibility from day 1     |
| 4    | G6 feedback loop                                                   | A promoted rule the app injects changes the next run           |

## Acceptance Criteria (cross-PRD)

1. A scheduled run enqueues with no human action; the run survives a worker
   restart mid-flight and completes (G2).
2. Many projects run cycles in parallel with zero cross-tenant reads —
   existing tenancy tests extended over every new table.
3. 100% of class-C tool calls are blocked without an approval record; expired
   approvals never execute; guard-failing class-B calls abort and file
   exceptions — all proven fail-closed by test (G3).
4. Rejecting an approval with a reason creates a candidate rule; promoting it
   makes the rule available (via the learned-rules listing API) to the next
   matching run (G6).
5. For any executed mutation, one query returns: agent, run, evidence,
   policy version, approver (G3).
6. Replayed/retried nodes produce exactly one `UsageMeter` row per LLM call
   (idempotency under at-least-once delivery) (G2+G5).

## Risks & Mitigations

- **API stability:** new resource types ship as beta until the full set lands;
  existing module APIs are not broken by any of these PRDs.
- **Scope creep toward a workflow engine:** durable execution stays scoped to
  checkpoint-resume of DAG runs. Anything more waits for real demand.
- **Scope creep toward application logic:** prompt/context composition
  (assembling doctrine and learned rules into agent context) stays in the
  consuming application, not the platform — see
  [roadmap → Boundary: context composition](./roadmap.md#boundary-context-composition).

### Operational Risks

- **Queue-table migration on live deployments (G2):** cutting
  `startOrchestrationRun` over to enqueue-only while runs are in flight risks
  stranded or double-driven runs. Mitigation: the `run_tasks` table ships as
  an additive migration (no backfill needed — pre-cutover runs keep their
  checkpoints and are finished by the existing lease/reaper machinery); new
  runs enqueue behind a feature flag, and only after the last pre-cutover run
  terminates is in-process driving removed. Rollback = flip the flag; the
  table is inert when unused.
- **Webhook fan-out amplification from metering events (G5):** metering is
  per-LLM-call; naively emitting a webhook per meter row would multiply every
  agent step into deliveries and melt receivers. Mitigation: raw `UsageMeter`
  rows never emit webhooks — only the aggregated `usage.threshold_crossed`
  event fires, at most once per project/threshold/window, and delivery reuses
  the existing webhooks module's retry/backoff so a slow receiver cannot back
  up the metering write path.
