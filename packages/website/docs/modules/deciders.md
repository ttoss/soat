---
description: "Deciders: versioned question sets in the OpenAI Decisions API shape, answered by an agent or a tool, producing append-only decisions."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Deciders

A decider is a named, versioned question set. Evaluated against an input, it produces a **decision**: one answer per question, each confined to the answer space the question declares, recorded append-only.

## Overview

Getting a machine-readable judgment out of an agent otherwise means configuring an `output_schema` and remembering, at every call site, which schema and which prompt produced the answer. A decider makes the judgment a resource: the questions are stored and versioned, the caller supplies only the input, and every decision names the version it was answered under.

- **The questions come from the decider**, never from the request, so no call site can widen what is judged. A one-off judgment sends its own questions instead; see [Inline questions](#inline-questions).
- **Every answer is confined** to its question's answer space: SOAT compiles the questions to the schema the answer must satisfy and refuses anything outside it.
- **A decision is append-only**: its `answers` are written once, when it settles, and never rewritten.
- **Two backends answer**: a tool-less agent, which SOAT prompts, or a tool, which receives the questions and answers them — a classifier, a calibrated model or any endpoint of your own.
- **The shapes are OpenAI's Decisions API**: questions, input and answers are those of its request and response, so a tool that forwards to `https://api.openai.com/v1/decisions`, with `model` as a preset parameter, answers a decider unchanged.

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
| `questions`   | array   | 1 to 20 [questions](#questions), in the order the model is shown them       |
| `created_at`  | string  | ISO 8601 creation timestamp                                                 |
| `updated_at`  | string  | ISO 8601 last-updated timestamp                                             |

### Decision

| Field             | Type    | Description                                                                                         |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `id`              | string  | Public identifier (e.g. `dec_…`)                                                                    |
| `project_id`      | string  | ID of the owning project                                                                            |
| `decider_id`      | string  | The decider asked; kept after the decider is deleted. Null for an [inline](#inline-questions) decision |
| `decider_version` | integer | The question-set version the decision was answered under. Null for an inline decision               |
| `questions`       | array   | The questions an inline decision was answered under. Null for a decider's decision                  |
| `status`          | string  | `queued` \| `running` \| `completed` \| `failed`                                                    |
| `answers`         | array   | One [answer](#answers) per question, in question order. Null until the decision completes           |
| `answers_by_name` | object  | The same answers keyed by question name. Null until the decision completes                          |
| `error`           | object  | `{ code, message }` on a `failed` decision                                                          |
| `generation_id`   | string  | The generation that answered; its receipt carries what the decision cost. Null for a tool          |
| `metadata`        | object  | Caller-owned annotations, written once with the decision                                            |
| `created_at`      | string  | ISO 8601 creation timestamp                                                                         |
| `updated_at`      | string  | ISO 8601 last-updated timestamp                                                                     |

The input is **not stored**. Put the id of what was judged in `metadata` (`{ "ticket_id": "ZD-48213" }`) to find a decision again.

`answers_by_name` lets a JSON Logic path read an answer by name — `answers_by_name.route.choice` — rather than by position, `answers.0.choice`.

### Questions

The question and answer shapes are those of OpenAI's Decisions API. `questions` is an array of 1 to 20 entries, shown to the model in that order. Every question has a `type`, a `name` and `instructions`:

| `type`      | Judges                     | Extra field                                                                                   |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `predicate` | Whether a condition holds  | —                                                                                             |
| `choice`    | Which option applies       | `choices`: 2 to 20 `{ value, description }`; each `value` unique within the question          |
| `score`     | Where it sits on a scale   | `levels`: 2 to 20 `{ label, description }`, ordered; a level is named by its zero-based index |

A `name` is unique within the set, starts with a letter or underscore and holds only letters, digits and underscores (at most 64). Every `value`, `label` and `description` is a non-empty string, and no field outside the table is accepted. A violation is `400 VALIDATION_FAILED`, naming the path.

### Answers

`answers` holds one entry per question, in question order, named after it:

| `type`      | Answer                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `predicate` | `{ "type": "predicate", "name", "probability" }` — the probability, 0 to 1, the condition holds  |
| `choice`    | `{ "type": "choice", "name", "choice", "probabilities"?, "confidence"? }` — `choice` is a `value` |
| `score`     | `{ "type": "score", "name", "score", "probabilities"?, "confidence"? }` — `score` is in 0 to levels − 1 |

`probabilities` is a distribution over the answer space: `[{ "value": "billing", "probability": 0.8 }]` for a choice, `[{ "value": 1, "label": "Workaround exists", "probability": 0.7 }]` for a score, `value` being the level index and `label` the decider's. `probabilities` and `confidence` come only from a [tool backend](#the-tool-backend); SOAT carries them as supplied and does not vouch for their meaning. An agent answers a predicate `true` or `false`, recorded as `probability` 1 or 0, and a score with a level index.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-decider \
  --project-id proj_… \
  --name support-triage \
  --agent-id agent_… \
  --questions '[
    {
      "type": "choice",
      "name": "route",
      "instructions": "Which team should own this ticket?",
      "choices": [
        { "value": "billing", "description": "Charges, refunds and invoices." },
        { "value": "technical", "description": "Errors and outages." }
      ]
    },
    {
      "type": "score",
      "name": "severity",
      "instructions": "How urgent is this ticket?",
      "levels": [
        { "label": "Cosmetic", "description": "Appearance only." },
        { "label": "Workaround exists", "description": "A task fails, but another way works." },
        { "label": "Blocked", "description": "No workaround." }
      ]
    },
    {
      "type": "predicate",
      "name": "needs_human",
      "instructions": "Must a person read this before any automated reply?"
    }
  ]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.deciders.createDecider({
  body: {
    project_id: 'proj_…',
    name: 'support-triage',
    agent_id: 'agent_…',
    questions: [
      {
        type: 'choice',
        name: 'route',
        instructions: 'Which team should own this ticket?',
        choices: [
          { value: 'billing', description: 'Charges, refunds and invoices.' },
          { value: 'technical', description: 'Errors and outages.' },
        ],
      },
      {
        type: 'score',
        name: 'severity',
        instructions: 'How urgent is this ticket?',
        levels: [
          { label: 'Cosmetic', description: 'Appearance only.' },
          { label: 'Workaround exists', description: 'A task fails, but another way works.' },
          { label: 'Blocked', description: 'No workaround.' },
        ],
      },
      {
        type: 'predicate',
        name: 'needs_human',
        instructions: 'Must a person read this before any automated reply?',
      },
    ],
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
    "questions": [
      {
        "type": "choice",
        "name": "route",
        "instructions": "Which team should own this ticket?",
        "choices": [
          { "value": "billing", "description": "Charges, refunds and invoices." },
          { "value": "technical", "description": "Errors and outages." }
        ]
      },
      {
        "type": "score",
        "name": "severity",
        "instructions": "How urgent is this ticket?",
        "levels": [
          { "label": "Cosmetic", "description": "Appearance only." },
          { "label": "Workaround exists", "description": "A task fails, but another way works." },
          { "label": "Blocked", "description": "No workaround." }
        ]
      },
      {
        "type": "predicate",
        "name": "needs_human",
        "instructions": "Must a person read this before any automated reply?"
      }
    ]
  }'
```

</TabItem>
</Tabs>

## Key Concepts

### Backends

A decider names exactly one of `agent_id` and `tool_id`. Naming one on [`PATCH /api/v1/deciders/{decider_id}`](/docs/api/deciders/update-decider) replaces the other; naming both, on a create or an update, is `400`. The backend is not part of the question set, so changing it leaves `version` alone.

### The agent runs tool-less

A decider's agent may carry no tool surface: no binding left active by `active_tool_ids`, and no `knowledge_config.write_memory_store_id`. A tool call is the only thing that parks a generation, and a decision has no route to resume one; nor may evaluating an input take a side effect the decision cannot record. Knowledge retrieval is inline, not a tool, and stays available.

The rule is checked when a decider is written and again when a decision is requested, since an agent is editable after a decider names it. Either refusal is `400 DECIDER_AGENT_NOT_TOOL_LESS`. A decider also keeps its agent from being deleted: [`DELETE /api/v1/agents/{agent_id}`](/docs/api/agents/delete-agent) answers `409 AGENT_HAS_DEPENDENTS` with `meta.decider_count`, even with `force=true`.

The agent stays thin: a model, a provider and, optionally, domain `instructions`. SOAT supplies the rest per decision, so one agent can back many deciders.

### What the agent receives

For each decision SOAT builds two things from the questions:

- **The output schema**: an object with one property per question name, all required — a boolean for a `predicate`, one of the `value`s for a `choice`, an integer from 0 to levels − 1 for a `score`. It replaces the agent's own `output_schema` for that generation.
- **The frame**: the input message, holding the questions with their instructions, choices and levels, then the input. The agent's `instructions` remain the system prompt.

For the decider above and the input `I was charged twice.`, the frame reads:

```text
Answer every question below about the input that follows. Choose each answer only from the ones its question offers.

## Questions

### route (choice)
Which team should own this ticket?
Answer with one of these values:
- billing: Charges, refunds and invoices.
- technical: Errors and outages.

### severity (score)
How urgent is this ticket?
Answer with the number of the level that fits:
- 0: Cosmetic. Appearance only.
- 1: Workaround exists. A task fails, but another way works.
- 2: Blocked. No workaround.

### needs_human (predicate)
Must a person read this before any automated reply?
Answer true if the condition holds, false otherwise.

## Input

<input>

I was charged twice.

</input>
```

The frame is kept in the generation's transcript, so every decision's generation shows exactly what the model was given. Its wording belongs to SOAT, not to the decider: `decider_version` tracks the questions, so a release that rewords the frame can move answers on an unchanged decider.

### Input

`input` takes the forms of OpenAI's Decisions API:

| Form | Example | The agent is shown |
| --- | --- | --- |
| A string | `"I was charged twice."` | The string as written |
| User messages | `[{ "role": "user", "content": [{ "type": "input_text", "text": "Is this damaged?" }, { "type": "input_image", "image_url": "data:image/png;base64,…" }] }]` | The text of every message, joined; each image is attached after the frame |
| Any other JSON | `{ "customer_id": "act_…", "amount": 400 }` | Indented JSON |

An array whose every entry carries `role` is read as messages and held to that shape: `role` is `user`, `content` is a string or a list of `input_text` and `input_image` parts, and an image is a base64 data URL. Anything else in it is `400 VALIDATION_FAILED`. A request without `input` is `400` too. A tool receives `input` exactly as sent.

### The tool backend

A decider can point at a [tool](./tools.md) instead of an agent. SOAT calls it as it calls any tool — with its [egress](./tools.md#where-a-tool-may-reach-egress) rules, [preset parameters](./tools.md#preset-parameters), [output mapping](./tools.md#output-mapping) and guardrails — and reads its answer against the questions.

Only `http` and `pipeline` tools can back a decider. A `client` tool has no caller to hand the call to, and an `mcp` or `builtin` tool needs an `action` a decider does not carry: wrap it in a [`pipeline`](./tools.md#pipeline) step, which names one. A tool whose `preset_parameters` pin `input` or `questions` is refused as well, since presets are merged over what the decider sends. Each is `400 DECIDER_TOOL_NOT_CALLABLE`, checked when the decider is written and again when a decision is requested. A decider keeps its tool from being deleted: [`DELETE /api/v1/tools/{tool_id}`](/docs/api/tools/delete-tool) answers `409 TOOL_HAS_DEPENDENTS` with `meta.decider_count`.

The tool runs as whoever requested the decision. A `builtin` pipeline step calls the API with the requester's credential, so it reads and writes only what the requester may: a step whose call the requester may not make fails the decision with `PIPELINE_STEP_FAILED`.

The tool receives the request body of OpenAI's Decisions API without `model`: the input as sent and the questions as stored, with no frame.

```json
{
  "input": "I was charged twice.",
  "questions": [
    { "type": "choice", "name": "route", "instructions": "…", "choices": [{ "value": "billing", "description": "…" }, { "value": "technical", "description": "…" }] }
  ]
}
```

It answers, after its own output mapping, with that API's response:

```json
{
  "answers": [
    {
      "type": "choice",
      "name": "route",
      "choice": "billing",
      "probabilities": [{ "value": "billing", "probability": 0.8 }, { "value": "technical", "probability": 0.2 }],
      "confidence": 0.8
    },
    { "name": "severity", "score": 1.3 },
    { "name": "needs_human", "probability": 0.1 }
  ]
}
```

- The answer is a JSON object, or text that parses to one. Keys beside `answers` are ignored.
- `answers` answers every question exactly once, in any order; the decision stores them in question order. A `name` that names no question is refused.
- `type` is optional and must match the question's.
- A `predicate` carries `probability` (0 to 1). A `choice` carries `choice`, one of its values. A `score` carries `score`, a number from 0 to levels − 1: a tool may weigh levels into a value between two.
- A `choice` or `score` may carry `probabilities`, each entry a `value` (a choice value, or a level index) and a `probability`, no value twice, and `confidence` (0 to 1). A score entry's `label` is accepted and replaced by the decider's.
- Any other field is refused.

An answer outside that contract settles the decision `failed` with `DECISION_ANSWER_INVALID`, naming the answer and the field. A failed call settles it with the tool's own code, such as `TOOL_HTTP_ERROR`.

### Answering with OpenAI's Decisions API

Since the tool receives the request body of OpenAI's Decisions API and answers in its response, an `http` tool that forwards to `https://api.openai.com/v1/decisions`, with `model` as a [preset parameter](./tools.md#preset-parameters), answers a decider unchanged:

```json
{
  "name": "openai-decisions",
  "type": "http",
  "execute": {
    "url": "https://api.openai.com/v1/decisions",
    "method": "POST",
    "headers": { "Authorization": "Bearer {{secret:sec_…}}" }
  },
  "preset_parameters": { "model": "gpt-6-luna" }
}
```

### Bridging an engine with a pipeline

A judgment engine that speaks almost this shape — `questions` in, `answers` out, but its own spelling for a field — is bridged with a [`pipeline`](./tools.md#pipeline) tool rather than code: a step's `input` rewrites the request, and the pipeline's `output` rewrites the answer. For an engine that takes the input as `text` and answers each question in a `results` map keyed by name, with a predicate's probability as `p_true`:

```json
{
  "name": "engine-triage",
  "type": "pipeline",
  "pipeline": {
    "steps": [{
      "id": "call",
      "tool_id": "tool_…",
      "input": {
        "text": { "var": "input.input" },
        "questions": { "var": "input.questions" }
      }
    }],
    "output": {
      "answers": [
        {
          "name": "route",
          "choice": { "var": "steps.call.results.route.choice" },
          "probabilities": { "var": "steps.call.results.route.probabilities" }
        },
        {
          "name": "needs_human",
          "probability": { "var": "steps.call.results.needs_human.p_true" }
        }
      ]
    }
  }
}
```

The output names each answer field, which is what leaves the engine's own extras behind. It also names each question: a question added to the decider later fails its decisions on the missing answer until the pipeline names it too.

### Versions

`version` starts at 1 and increments on every write that changes `questions`; each version's question set is archived. A rename, a new description, a new backend or a rewrite of the questions the decider already holds leaves it alone. Because every decision names its `decider_version`, rewording a level never reinterprets an earlier answer: read the questions a decision was answered under with [`GET /api/v1/deciders/{decider_id}/versions/{version}`](/docs/api/deciders/get-decider-version).

[`PATCH /api/v1/deciders/{decider_id}`](/docs/api/deciders/update-decider) takes `expected_version` (or `If-Match`) and answers `409 VERSION_CONFLICT` on a stale one. [`POST /api/v1/deciders/{decider_id}/versions/{version}/restore`](/docs/api/deciders/restore-decider-version) writes an archived question set back as a new version.

### Requesting a decision

[`POST /api/v1/deciders/{decider_id}/decisions`](/docs/api/deciders/create-decision) takes `input`, optional `metadata` and `wait`. The decision is a run: with `wait` omitted it is `201` in `status: queued`, and with `wait: true` it is `201` settled. Poll [`GET /api/v1/decisions/{decision_id}`](/docs/api/deciders/get-decision) or subscribe to the events below; see [Synchronous & Asynchronous Execution](../advanced/sync-and-async.md#two-combinations-that-are-resolved-for-you) for the contract, including how a [`builtin` tool](./tools.md#data-model) or MCP call waits.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-decision \
  --decider-id dcd_… \
  --input 'I was charged twice for the same order.' \
  --metadata '{ "ticket_id": "ZD-48213" }' \
  --wait true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.deciders.createDecision({
  path: { decider_id: 'dcd_…' },
  body: {
    input: 'I was charged twice for the same order.',
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
    "input": "I was charged twice for the same order.",
    "metadata": { "ticket_id": "ZD-48213" },
    "wait": true
  }'
```

</TabItem>
</Tabs>

A settled agent decision on the decider above reads:

```json
{
  "id": "dec_…",
  "decider_id": "dcd_…",
  "decider_version": 1,
  "questions": null,
  "status": "completed",
  "answers": [
    { "type": "choice", "name": "route", "choice": "billing" },
    { "type": "score", "name": "severity", "score": 1 },
    { "type": "predicate", "name": "needs_human", "probability": 0 }
  ],
  "answers_by_name": {
    "route": { "type": "choice", "name": "route", "choice": "billing" },
    "severity": { "type": "score", "name": "severity", "score": 1 },
    "needs_human": { "type": "predicate", "name": "needs_human", "probability": 0 }
  },
  "metadata": { "ticket_id": "ZD-48213" }
}
```

Everything that can refuse the request runs before the decision is written, so a refusal is never a polled failure: invalid `input` or questions, the agent's tool surface or a tool that cannot answer (`400`), a [paused project](./projects.md) (`409 PROJECT_PAUSED`) and, for an agent, quota admission (`429 QUOTA_EXCEEDED`).

A decision that settles `failed` carries the reason in `error.code` — for example `OUTPUT_SCHEMA_VALIDATION_FAILED` when the model answered outside the answer space, or `DECISION_ANSWER_INVALID` when a tool did. Failure is terminal: request a new decision.

[`GET /api/v1/decisions`](/docs/api/deciders/list-decisions) lists a project's decisions, filtered by `decider_id` and `status`. Deleting a decider leaves its decisions in place.

### Inline questions

A judgment asked once, or composed by the caller, needs no decider: [`POST /api/v1/decisions`](/docs/api/deciders/create-inline-decision) takes the `questions` with the request, the `input`, exactly one of `agent_id` and `tool_id`, and optional `metadata` and `wait`. It is the request of OpenAI's Decisions API with the backend in place of `model`.

The backend is held to the rules of a decider's ([tool-less agent](#the-agent-runs-tool-less), [callable tool](#the-tool-backend)), the questions to those of [Questions](#questions), and admission, `wait` and the tool contract are those of [Requesting a decision](#requesting-a-decision). Naming both backends or neither is `400 VALIDATION_FAILED`; an agent or tool outside the project is `400 AGENT_NOT_FOUND` or `400 TOOL_NOT_FOUND`.

No version names the questions, so the decision stores them in `questions`, with `decider_id` and `decider_version` null. Filter a listing to `decider_id` to leave inline decisions out.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-inline-decision \
  --project-id proj_… \
  --agent-id agent_… \
  --questions '[
    {
      "type": "predicate",
      "name": "visible_damage",
      "instructions": "Does the product have visible damage?"
    }
  ]' \
  --input '[
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Photo of the returned item." },
        { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo…" }
      ]
    }
  ]' \
  --metadata '{ "return_id": "RMA-1042" }' \
  --wait true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.deciders.createInlineDecision({
  body: {
    project_id: 'proj_…',
    agent_id: 'agent_…',
    questions: [
      {
        type: 'predicate',
        name: 'visible_damage',
        instructions: 'Does the product have visible damage?',
      },
    ],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Photo of the returned item.' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo…' },
        ],
      },
    ],
    metadata: { return_id: 'RMA-1042' },
    wait: true,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/decisions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_…",
    "agent_id": "agent_…",
    "questions": [
      {
        "type": "predicate",
        "name": "visible_damage",
        "instructions": "Does the product have visible damage?"
      }
    ],
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Photo of the returned item." },
          { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo…" }
        ]
      }
    ],
    "metadata": { "return_id": "RMA-1042" },
    "wait": true
  }'
```

</TabItem>
</Tabs>

The IAM action is `deciders:CreateInlineDecision`, on the `decision` resource type.

### Interrupted decisions

A decision is evaluated by the process that accepted it. One still unsettled when its lease expires — the process stopped — is settled `failed` with `DECISION_INTERRUPTED` by a sweep. The input was never stored, so it cannot be re-run: request a new decision.

### Metering

A decision's generation is metered like any other, with `source: decider`, so decision spend is separable in [usage](./usage.md) rollups; an inline decision is metered the same way. A tool-backed decision is a `tool_execution` event with the same `source`; it has no generation, so it admits no generation quota. Decision rows count toward the project's `record_gb_day`.

### Grading an eval

A [`decider` scorer](./evaluations.md#decider-scorers-decider) grades each item of an eval run with a decision, pinned to the decider version the run started under, so the questions production asks are the ones the eval measures.

### Events

| Event                 | When                                                        |
| --------------------- | ----------------------------------------------------------- |
| `decisions.completed` | A decision settled with its answers                          |
| `decisions.failed`    | A decision settled without answers; the payload carries `error` |

Both carry the decision, inline or not, with `answers` and `answers_by_name`. See [Webhooks](./webhooks.md).

### Formations

A `decider` [formation](./formations.md) resource (`DeciderResourceProperties`) takes `name`, `description`, `questions` (the array of [Questions](#questions)) and exactly one of `agent_id` and `tool_id`, each of which may be a `{ "ref": "ResourceName" }` to an `agent` or `tool` resource in the same template. The questions are validated as on [`POST /api/v1/deciders`](/docs/api/deciders/create-decider), and a template update that changes them archives a new version. Tearing a stack down deletes a decider before the agent or tool it names; a decider outside the stack still keeps that agent or tool, and the teardown is refused before anything is deleted.

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
        "questions": [
          {
            "type": "predicate",
            "name": "needs_human",
            "instructions": "Must a person read this before any automated reply?"
          }
        ]
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

| Code                          | Status | When                                                                              |
| ----------------------------- | ------ | --------------------------------------------------------------------------------- |
| `DECIDER_AGENT_NOT_TOOL_LESS` | 400    | The agent has a tool surface, on a decider write or a decision request            |
| `DECIDER_TOOL_NOT_CALLABLE`   | 400    | The tool is not `http` or `pipeline`, or pins `input` or `questions`              |
| `AGENT_NOT_FOUND`             | 400    | `agent_id` names no agent in the project                                          |
| `TOOL_NOT_FOUND`              | 400    | `tool_id` names no tool in the project                                            |
| `VALIDATION_FAILED`           | 400    | Invalid questions or `input`, a write naming both backends, or one naming neither |
| `NAME_CONFLICT`               | 409    | Another decider in the project has the name                                       |
| `VERSION_CONFLICT`            | 409    | `expected_version` is stale                                                       |
| `PROJECT_PAUSED`              | 409    | The project is paused                                                             |
| `QUOTA_EXCEEDED`              | 429    | A generation quota is exhausted                                                   |
| `DECISION_INTERRUPTED`        | —      | Recorded on a decision whose evaluation stopped before it settled                 |
| `DECISION_ANSWER_INVALID`     | —      | Recorded on a decision whose tool answered outside the contract                   |
