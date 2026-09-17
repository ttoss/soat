---
description: 'Reusable, versioned question sets evaluated by a System One model — typed answers your code branches on directly, with no generated text to parse.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Deciders

Reusable, versioned question sets evaluated by a System One model.

## Overview

A decider is to a System One model what an [agent](./agents.md) is to an LLM:
the named, versioned configuration a caller invokes. Evaluating one against a
state produces a **decision** — typed values and probability distributions
rather than generated text, so calling code branches on the answer directly.

Deciders hold the questions; [AI Providers](./ai-providers.md) hold the
credential. A decider's provider must carry the `typesafe` slug; any other is
refused with `VALIDATION_FAILED` on write.

> See the [Permissions Reference](../permissions.md) for the IAM action strings
> for this module.

## Data Model

### Decider

| Field            | Type             | Description                                                                 |
| ---------------- | ---------------- | --------------------------------------------------------------------------- |
| `id`             | string           | Public identifier prefixed with `dcd_`                                      |
| `project_id`     | string           | ID of the owning project                                                    |
| `name`           | string           | Human-readable name                                                         |
| `description`    | string \| null   | Optional description                                                        |
| `version`        | integer          | Incremented on every `questions` write; see [Versioning](#versioning)       |
| `ai_provider_id` | string           | A `typesafe` [AI provider](./ai-providers.md) in the same project           |
| `model`          | string           | System One model. Falls back to the provider's `default_model`, then `jev-latest` |
| `questions`      | object           | The question set, keyed by question ID — see [Questions](#questions)        |
| `created_at`     | string           | ISO 8601 creation timestamp                                                 |
| `updated_at`     | string           | ISO 8601 last-updated timestamp                                             |

### Decision

Append-only. A decision is evidence of what the system decided at a point in
time, so it is written once and never updated.

| Field             | Type    | Description                                                            |
| ----------------- | ------- | ---------------------------------------------------------------------- |
| `id`              | string  | Public identifier prefixed with `dec_`                                 |
| `project_id`      | string  | ID of the owning project                                               |
| `decider_id`      | string  | The decider evaluated. Kept even once that decider is deleted          |
| `decider_version` | integer | The decider version that produced these answers                        |
| `model`           | string  | The model that answered                                                |
| `answers`         | object  | Typed answers keyed by question ID — see [Answers](#answers)           |
| `usage`           | object  | `input_tokens` and `output_tokens` reported by the provider            |
| `created_at`      | string  | ISO 8601 creation timestamp                                            |

## Key Concepts

### Questions

A question has an ID, a `type`, `instructions` and — for two of the three types
— `criteria`. The ID names the answer in a decision and is never sent to the
model, so `instructions` must carry the complete question.

| Type     | Asks                    | Answer carries                                   |
| -------- | ----------------------- | ------------------------------------------------ |
| `choice` | Which of these options? | `choice`, `probabilities`, `confidence`          |
| `score`  | Which level?            | `score`, `legend`, `probabilities`, `confidence` |
| `noul`   | Is this true?           | `noul` (0 to 1)                                  |

`criteria` is an object mapping option to description for a Choice, an ordered
array of level descriptions for a Score, and an optional clarification of what
yes and no mean for a Noul. A Choice needs at least two options and a Score at
least two levels: with one, there is no judgment to make. All of this is
validated when the decider is written, not when it is evaluated.

```json
{
  "department": {
    "type": "choice",
    "instructions": "Which team should handle this",
    "criteria": {
      "billing": "Payment or subscription issues",
      "technical": "Bugs or integration problems",
      "sales": "Pricing or account questions"
    }
  },
  "frustration": {
    "type": "score",
    "instructions": "How frustrated the customer appears",
    "criteria": [
      "Calm, just stating facts",
      "Frustrated but civil",
      "Very angry, strong language"
    ]
  },
  "is_urgent": {
    "type": "noul",
    "instructions": "The message conveys urgency or time-sensitivity"
  }
}
```

### Ask one thing per question

A question asks for one snap judgment: "Does this message convey urgency?",
not "analyse this and determine the best course of action". A judgment that
depends on several independent factors becomes one question per factor,
combined with weights in calling code.

Every question in a decider is evaluated in parallel and in isolation against
the same state. Adding questions barely changes the response time, and one
question's answer is never context for another.

### Answers

An answer is constrained to the supplied options: the model returns a
distribution over them, never a value outside them.

`confidence` reports how peaked that distribution is, separately from the answer
itself. A Noul carries no `confidence` — its value is already a probability,
and near 0.5 means yes and no are given equal weight.

### State

The state is what is being judged: a string, or a JSON object whose parts the
questions address by path (`` Does `ticket.messages[0].text` request a refund?
``). It reaches the model as given.

The state is **not stored** on the decision — this table has no retention or
purge path of its own. A caller that needs the input kept records it alongside
the decision id.

### Versioning

`version` starts at 1 and is incremented whenever `questions` is written.
Renaming a decider, or repointing it at another provider or model, leaves it
alone.

Every decision names the `decider_version` that produced it, so rewording a
level never reinterprets answers recorded before the change.

### The provider cannot back an agent

A `typesafe` provider returns no token stream, so it cannot back an
[agent](./agents.md), a [chat](./chats.md) or a
[model route](./model-routes.md): those fail with
`AI_PROVIDER_MISCONFIGURED`.

A decider referencing a provider blocks that provider's deletion, as a chat or
an agent does. `force` does not override it.

### Deletion

Deleting a decider keeps the decisions it produced. Each holds the decider's ID
as a dangling reference, as a [guardrail evaluation](./guardrails.md) outlives
its guardrail.

## Examples

<Tabs groupId="client">
<TabItem value="cli" label="CLI">

```bash
# Create a decider from a question set
soat create-decider --project_id proj_01 --name "Support Triage" \
  --ai_provider_id aip_01 \
  --questions '{"is_urgent":{"type":"noul","instructions":"The message conveys urgency"}}'

# Evaluate it against a state
soat evaluate-decider --decider_id dcd_01 \
  --state "Our API has returned 500 on every request for 20 minutes."

# Read the decider and the decisions it produced
soat get-decider --decider_id dcd_01
soat list-decisions --project_id proj_01 --decider_id dcd_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: decider } = await client.POST('/api/v1/deciders', {
  body: {
    project_id: 'proj_01',
    name: 'Support Triage',
    ai_provider_id: 'aip_01',
    questions: {
      is_urgent: {
        type: 'noul',
        instructions: 'The message conveys urgency',
      },
    },
  },
});

const { data: decision } = await client.POST(
  '/api/v1/deciders/{decider_id}/evaluate',
  {
    params: { path: { decider_id: decider!.id } },
    body: { state: 'Our API has returned 500 for 20 minutes.' },
  }
);

if (decision!.answers.is_urgent.noul > 0.9) {
  await page(onCall);
}

const { data: decisions } = await client.GET('/api/v1/decisions', {
  params: { query: { decider_id: decider!.id } },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_01","name":"Support Triage","ai_provider_id":"aip_01","questions":{"is_urgent":{"type":"noul","instructions":"The message conveys urgency"}}}' \
  "$SOAT_BASE_URL/api/v1/deciders"

curl -X POST -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state":"Our API has returned 500 for 20 minutes."}' \
  "$SOAT_BASE_URL/api/v1/deciders/dcd_01/evaluate"

curl -H "Authorization: Bearer $SOAT_TOKEN" \
  "$SOAT_BASE_URL/api/v1/decisions?decider_id=dcd_01"
```

</TabItem>
</Tabs>

## Errors

| Code                        | When                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `VALIDATION_FAILED`         | A malformed question set, a missing `state`, or a provider that is not `typesafe` |
| `AI_PROVIDER_NOT_FOUND`     | `ai_provider_id` names no provider in this project                    |
| `AI_PROVIDER_MISCONFIGURED` | The provider links no secret, so there is no API key to call with     |
| `AI_PROVIDER_ERROR`         | The provider was unreachable, rejected the request, or answered with a body carrying no usable value |
