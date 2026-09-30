---
description: "Deciders: versioned question sets an agent or tool answers against a state, producing append-only decisions confined to each answer space."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Deciders

A decider is a named, versioned question set. Evaluated against a state, it produces a **decision**: one answer per question, each confined to the answer space the question declares, recorded append-only.

## Overview

Getting a machine-readable judgment out of an agent otherwise means configuring an `output_schema` and remembering, at every call site, which schema and which prompt produced the answer. A decider makes the judgment a resource: the questions are stored and versioned, the caller supplies only the state, and every decision names the version it was answered under.

- **The questions come from the decider**, never from the request, so no call site can widen what is judged.
- **Every answer is confined** to its question's answer space: SOAT compiles the questions to the schema the answer must satisfy and refuses anything outside it.
- **A decision is append-only**: its `answers` are written once, when it settles, and never rewritten.
- **Two backends answer**: a tool-less agent, which SOAT prompts, or a tool, which receives the question set and answers it — a classifier, a calibrated model or any endpoint of your own.

## Related Tutorials

- [Route Work with a Decider](/docs/tutorials/route-work-with-a-decider) — a tool-backed decider applies rules to a customer's actor tags, and an orchestration branches on its answer
- [Grade an Eval with a Decider](/docs/tutorials/grade-an-eval-with-a-decider) — a decider backed by TypeSafe Jev reviews a live reply, then grades every item of an eval

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Decider

| Field         | Type    | Description                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------- |
| `id`          | string  | Public identifier (e.g. `dcd_…`)                                            |
| `project_id`  | string  | ID of the owning project                                                    |
| `name`        | string  | Human-readable name, unique per project                                     |
| `description` | string  | Optional                                                                    |
| `agent_id`    | string  | The [tool-less agent](#the-agent-runs-tool-less) that answers, or null      |
| `tool_id`     | string  | The [tool](#the-tool-backend) that answers, or null                         |
| `version`     | integer | The question set's version; see [Versions](#versions)                       |
| `questions`   | object  | Question id → question; see [Questions](#questions). 1 to 20 questions      |
| `created_at`  | string  | ISO 8601 creation timestamp                                                 |
| `updated_at`  | string  | ISO 8601 last-updated timestamp                                             |

### Decision

| Field             | Type    | Description                                                                               |
| ----------------- | ------- | ----------------------------------------------------------------------------------------- |
| `id`              | string  | Public identifier (e.g. `dec_…`)                                                          |
| `project_id`      | string  | ID of the owning project                                                                  |
| `decider_id`      | string  | The decider asked; kept after the decider is deleted                                      |
| `decider_version` | integer | The question-set version the decision was answered under                                  |
| `status`          | string  | `queued` \| `running` \| `completed` \| `failed`                                          |
| `answers`         | object  | Question id → answer. Null until the decision completes                                   |
| `error`           | object  | `{ code, message }` on a `failed` decision                                                |
| `generation_id`   | string  | The generation that answered; its receipt carries what the decision cost. Null for a tool |
| `metadata`        | object  | Caller-owned annotations, written once with the decision                                  |
| `created_at`      | string  | ISO 8601 creation timestamp                                                               |
| `updated_at`      | string  | ISO 8601 last-updated timestamp                                                           |

The evaluated state is **not stored**. Put the id of what was judged in `metadata` (`{ "ticket_id": "ZD-48213" }`) to find a decision again.

### Questions

A question id starts with a letter or underscore and holds only letters, digits and underscores (at most 64). Every question has a `type`, `instructions` and, depending on the type, `criteria`:

| `type`    | `criteria`                                                  | Answer                                    |
| --------- | ----------------------------------------------------------- | ----------------------------------------- |
| `choice`  | Option → description, 2 to 20 options                        | `{ "type": "choice", "choice": "<option>" }` |
| `score`   | Ordered level descriptions, 2 to 20 levels                   | `{ "type": "score", "score": <index>, "legend": "<level>" }` |
| `boolean` | Optional `{ "false": "…", "true": "…" }`                     | `{ "type": "boolean", "value": <bool> }`  |

A `score` answer is the level's zero-based index; `legend` is the level's text, taken from the decider. With a single option or level there is no judgment to make, so both need at least two.

An answer from a tool may also carry `probabilities`, a distribution over the answer space keyed by option, by level index as a string, or by `"true"` / `"false"`. It is the one field that expresses certainty; SOAT carries it as the tool supplied it and does not vouch for its meaning.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-decider \
  --project-id proj_… \
  --name support-triage \
  --agent-id agent_… \
  --questions '{
    "route": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": { "billing": "Charges, refunds, invoices", "technical": "Errors, outages" }
    },
    "severity": {
      "type": "score",
      "instructions": "How urgent is this ticket?",
      "criteria": ["Cosmetic", "Workaround exists", "Blocks one customer"]
    },
    "needs_human": {
      "type": "boolean",
      "instructions": "Must a person read this before any automated reply?"
    }
  }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.deciders.createDecider({
  body: {
    project_id: 'proj_…',
    name: 'support-triage',
    agent_id: 'agent_…',
    questions: {
      "route": {
        "type": "choice",
        "instructions": "Which team should own this ticket?",
        "criteria": {
          "billing": "Charges, refunds, invoices",
          "technical": "Errors, outages"
        }
      },
      "severity": {
        "type": "score",
        "instructions": "How urgent is this ticket?",
        "criteria": [
          "Cosmetic",
          "Workaround exists",
          "Blocks one customer"
        ]
      },
      "needs_human": {
        "type": "boolean",
        "instructions": "Must a person read this before any automated reply?"
      }
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/deciders \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_…",
    "name": "support-triage",
    "agent_id": "agent_…",
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "Which team should own this ticket?",
        "criteria": {
          "billing": "Charges, refunds, invoices",
          "technical": "Errors, outages"
        }
      },
      "severity": {
        "type": "score",
        "instructions": "How urgent is this ticket?",
        "criteria": [
          "Cosmetic",
          "Workaround exists",
          "Blocks one customer"
        ]
      },
      "needs_human": {
        "type": "boolean",
        "instructions": "Must a person read this before any automated reply?"
      }
    }
  }'
```

</TabItem>
</Tabs>

## Key Concepts

### Backends

A decider names exactly one of `agent_id` and `tool_id`. Naming one on [`PATCH /api/v1/deciders/{decider_id}`](/docs/api/deciders/update-decider) replaces the other; naming both, on a create or an update, is `400`. The backend is not part of the question set, so changing it leaves `version` alone.

### The agent runs tool-less

A decider's agent may carry no tool surface: no binding left active by `active_tool_ids`, and no `knowledge_config.write_memory_store_id`. A tool call is the only thing that parks a generation, and a decision has no route to resume one; nor may evaluating a state take a side effect the decision cannot record. Knowledge retrieval is inline, not a tool, and stays available.

The rule is checked when a decider is written and again when a decision is requested, since an agent is editable after a decider names it. Either refusal is `400 DECIDER_AGENT_NOT_TOOL_LESS`. A decider also keeps its agent from being deleted: [`DELETE /api/v1/agents/{agent_id}`](/docs/api/agents/delete-agent) answers `409 AGENT_HAS_DEPENDENTS` with `meta.decider_count`, even with `force=true`.

The agent stays thin: a model, a provider and, optionally, domain `instructions`. SOAT supplies the rest per decision, so one agent can back many deciders.

### What the agent receives

For each decision SOAT builds two things from the questions:

- **The output schema**: one property per question, each confined to its answer space, all required. It replaces the agent's own `output_schema` for that generation.
- **The frame**: the input message, holding the questions with their instructions and criteria, then the state. The agent's `instructions` remain the system prompt.

For the decider above and the state `I was charged twice.`, the frame reads:

```text
Answer every question below about the state that follows. Choose each answer only from the ones its question offers.

## Questions

### route (choice)
Which team should own this ticket?
Answer with one of these options:
- billing: Charges, refunds, invoices
- technical: Errors, outages

### severity (score)
How urgent is this ticket?
Answer with the number of the level that fits:
- 0: Cosmetic
- 1: Workaround exists
- 2: Blocks one customer

### needs_human (boolean)
Must a person read this before any automated reply?
Answer true or false.

## State

<state>

I was charged twice.

</state>
```

A string state is shown as written; any other JSON value as indented JSON. The frame is kept in the generation's transcript, so every decision's generation shows exactly the criteria the model was given.

The frame's wording belongs to SOAT, not to the decider: `decider_version` tracks the questions, so a release that rewords the frame can move answers on an unchanged decider.

### The tool backend

A decider can point at a [tool](./tools.md) instead of an agent. SOAT calls it as it calls any tool — with its [egress](./tools.md#where-a-tool-may-reach-egress) rules, [preset parameters](./tools.md#preset-parameters), [output mapping](./tools.md#output-mapping) and guardrails — and reads its answer against the question set.

Only `http` and `pipeline` tools can back a decider. A `client` tool has no caller to hand the call to, and an `mcp` or `builtin` tool needs an `action` a decider does not carry: wrap it in a [`pipeline`](./tools.md#pipeline) step, which names one. A tool whose `preset_parameters` pin `state` or `questions` is refused as well, since presets are merged over what the decider sends. Each is `400 DECIDER_TOOL_NOT_CALLABLE`, checked when the decider is written and again when a decision is requested. A decider keeps its tool from being deleted: [`DELETE /api/v1/tools/{tool_id}`](/docs/api/tools/delete-tool) answers `409 TOOL_HAS_DEPENDENTS` with `meta.decider_count`.

The tool runs as whoever requested the decision. A `builtin` pipeline step calls the API with the requester's credential, so it reads and writes only what the requester may: a step whose call the requester may not make fails the decision with `PIPELINE_STEP_FAILED`.

The tool receives the state and the question set exactly as stored, with no frame:

```json
{ "state": "I was charged twice.", "questions": { "route": { "type": "choice", "instructions": "…", "criteria": { "…": "…" } } } }
```

It answers, after its own output mapping, with one entry per question:

```json
{
  "answers": {
    "route": { "choice": "billing", "probabilities": { "billing": 0.8, "technical": 0.2 } },
    "severity": { "score": 1 },
    "needs_human": { "value": false }
  }
}
```

- The answer is a JSON object, or text that parses to one. Keys beside `answers` are ignored.
- `answers` holds every question id and no other.
- Each answer carries `choice`, `score` or `value` by the question's type, and optionally `type` (which must match), `probabilities` and, on a `score`, `legend` (ignored: SOAT takes the level's text from the decider).
- Any other field, such as `confidence`, is refused.

An answer outside that contract settles the decision `failed` with `DECISION_ANSWER_INVALID`, naming the question and the field. A failed call settles it with the tool's own code, such as `TOOL_HTTP_ERROR`.

### Bridging an engine with a pipeline

A judgment engine that speaks almost this shape — a `questions` map in, `answers` with `probabilities` out, but its own spelling for a field — is bridged with a [`pipeline`](./tools.md#pipeline) tool rather than code: a step's `input` rewrites the request, and the pipeline's `output` rewrites the answer. For an engine that takes a boolean question as `type: "noul"` and answers it as `noul`, a probability of true, with a `confidence` beside it:

```json
{
  "name": "engine-triage",
  "type": "pipeline",
  "pipeline": {
    "steps": [{
      "id": "call",
      "tool_id": "tool_…",
      "input": {
        "state": { "var": "input.state" },
        "questions": {
          "route": { "var": "input.questions.route" },
          "needs_human": {
            "type": "noul",
            "instructions": { "var": "input.questions.needs_human.instructions" },
            "criteria": { "var": "input.questions.needs_human.criteria" }
          }
        }
      }
    }],
    "output": {
      "answers": {
        "route": {
          "choice": { "var": "steps.call.answers.route.choice" },
          "probabilities": { "var": "steps.call.answers.route.probabilities" }
        },
        "needs_human": {
          "value": { ">=": [{ "var": "steps.call.answers.needs_human.noul" }, 0.5] },
          "probabilities": {
            "true": { "var": "steps.call.answers.needs_human.noul" },
            "false": { "-": [1, { "var": "steps.call.answers.needs_human.noul" }] }
          }
        }
      }
    }
  }
}
```

The output names each answer field, which is what leaves `confidence` behind. It also names each question id: a question added to the decider later fails its decisions on the missing answer until the pipeline names it too.

### Versions

`version` starts at 1 and increments on every write that changes `questions`; each version's question set is archived. A rename, a new description, a new backend or a rewrite of the questions the decider already holds leaves it alone. Because every decision names its `decider_version`, rewording a level never reinterprets an earlier answer: read the criteria a decision was answered under with [`GET /api/v1/deciders/{decider_id}/versions/{version}`](/docs/api/deciders/get-decider-version).

[`PATCH /api/v1/deciders/{decider_id}`](/docs/api/deciders/update-decider) takes `expected_version` (or `If-Match`) and answers `409 VERSION_CONFLICT` on a stale one. [`POST /api/v1/deciders/{decider_id}/versions/{version}/restore`](/docs/api/deciders/restore-decider-version) writes an archived question set back as a new version.

### Requesting a decision

[`POST /api/v1/deciders/{decider_id}/decisions`](/docs/api/deciders/create-decision) takes `state`, optional `metadata` and `wait`. The decision is a run: with `wait` omitted it is `201` in `status: queued`, and with `wait: true` it is `201` settled. Poll [`GET /api/v1/decisions/{decision_id}`](/docs/api/deciders/get-decision) or subscribe to the events below; see [Synchronous & Asynchronous Execution](../advanced/sync-and-async.md#two-combinations-that-are-resolved-for-you) for the contract, including how a [`builtin` tool](./tools.md#data-model) or MCP call waits.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-decision \
  --decider-id dcd_… \
  --state 'I was charged twice for the same order.' \
  --metadata '{ "ticket_id": "ZD-48213" }' \
  --wait true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.deciders.createDecision({
  path: { decider_id: 'dcd_…' },
  body: {
    state: 'I was charged twice for the same order.',
    metadata: { ticket_id: 'ZD-48213' },
    wait: true,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/deciders/dcd_…/decisions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "I was charged twice for the same order.",
    "metadata": { "ticket_id": "ZD-48213" },
    "wait": true
  }'
```

</TabItem>
</Tabs>

Everything that can refuse the request runs before the decision is written, so a refusal is never a polled failure: the agent's tool surface or a tool that cannot answer (`400`), a [paused project](./projects.md) (`409 PROJECT_PAUSED`) and, for an agent, quota admission (`429 QUOTA_EXCEEDED`).

A decision that settles `failed` carries the reason in `error.code` — for example `OUTPUT_SCHEMA_VALIDATION_FAILED` when the model answered outside the answer space, or `DECISION_ANSWER_INVALID` when a tool did. Failure is terminal: request a new decision.

[`GET /api/v1/decisions`](/docs/api/deciders/list-decisions) lists a project's decisions, filtered by `decider_id` and `status`. Deleting a decider leaves its decisions in place.

### Interrupted decisions

A decision is evaluated by the process that accepted it. One still unsettled when its lease expires — the process stopped — is settled `failed` with `DECISION_INTERRUPTED` by a sweep. The state was never stored, so it cannot be re-run: request a new decision.

### Metering

A decision's generation is metered like any other, with `source: decider`, so decision spend is separable in [usage](./usage.md) rollups. A tool-backed decision is a `tool_execution` event with the same `source`; it has no generation, so it admits no generation quota. Decision rows count toward the project's `record_gb_day`.

### Grading an eval

A [`decider` scorer](./evaluations.md#decider-scorers-decider) grades each item of an eval run with a decision, pinned to the decider version the run started under, so the questions production asks are the ones the eval measures.

### Events

| Event                 | When                                                        |
| --------------------- | ----------------------------------------------------------- |
| `decisions.completed` | A decision settled with its answers                          |
| `decisions.failed`    | A decision settled without answers; the payload carries `error` |

Both carry the decision. See [Webhooks](./webhooks.md).

### Formations

A `decider` [formation](./formations.md) resource (`DeciderResourceProperties`) takes `name`, `description`, `questions` and exactly one of `agent_id` and `tool_id`, each of which may be a `{ "ref": "ResourceName" }` to an `agent` or `tool` resource in the same template. The questions are validated as on [`POST /api/v1/deciders`](/docs/api/deciders/create-decider), and a template update that changes them archives a new version. Tearing a stack down deletes a decider before the agent or tool it names; a decider outside the stack still keeps that agent or tool, and the teardown is refused before anything is deleted.

```json
{
  "resources": {
    "Judge": {
      "type": "agent",
      "properties": { "ai_provider_id": "aip_…", "name": "triage-judge" }
    },
    "Triage": {
      "type": "decider",
      "properties": {
        "name": "support-triage",
        "agent_id": { "ref": "Judge" },
        "questions": {
          "needs_human": {
            "type": "boolean",
            "instructions": "Must a person read this before any automated reply?"
          }
        }
      }
    }
  }
}
```

## Configuration

| Variable                          | Default | Description                                         |
| --------------------------------- | ------- | --------------------------------------------------- |
| `DECISIONS_SCHEDULER_INTERVAL_MS` | `60000` | How often the interrupted-decision sweep runs        |

## Errors

| Code                          | Status | When                                                                    |
| ----------------------------- | ------ | ----------------------------------------------------------------------- |
| `DECIDER_AGENT_NOT_TOOL_LESS` | 400    | The agent has a tool surface, on a decider write or a decision request  |
| `DECIDER_TOOL_NOT_CALLABLE`   | 400    | The tool is not `http` or `pipeline`, or pins `state` or `questions`    |
| `AGENT_NOT_FOUND`             | 400    | `agent_id` names no agent in the decider's project                      |
| `TOOL_NOT_FOUND`              | 400    | `tool_id` names no tool in the decider's project                        |
| `VALIDATION_FAILED`           | 400    | A write names both backends, or a create names neither                  |
| `NAME_CONFLICT`               | 409    | Another decider in the project has the name                             |
| `VERSION_CONFLICT`            | 409    | `expected_version` is stale                                             |
| `PROJECT_PAUSED`              | 409    | The project is paused                                                   |
| `QUOTA_EXCEEDED`              | 429    | A generation quota is exhausted                                         |
| `DECISION_INTERRUPTED`        | —      | Recorded on a decision whose evaluation stopped before it settled       |
| `DECISION_ANSWER_INVALID`     | —      | Recorded on a decision whose tool answered outside the contract         |
