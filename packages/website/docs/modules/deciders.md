---
description: 'Reusable, versioned question sets evaluated by a System One model — typed answers your code branches on directly, with no generated text to parse.'
---

# Deciders

Reusable, versioned question sets evaluated by a System One model. Evaluating a
decider produces a **decision**: typed answers your code acts on directly.

## Overview

A decider is to a System One model what an [agent](./agents.md) is to an LLM —
the named, versioned configuration a caller invokes, rather than the call
itself.

An LLM produces text for a person to read. When the thing you need is a
judgment your *code* consumes, that text has to be coaxed into a shape and
parsed back out. A System One model skips that: it evaluates typed questions
against a state and returns typed values and probability distributions. Your
code branches on them.

Deciders hold the questions; [AI Providers](./ai-providers.md) hold the
credential. A decider must point at a provider whose `provider` is `typesafe`;
any other slug is refused on write, because a text-generation endpoint cannot
serve this call at all.

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

A System One model answers the kind of judgment a knowledgeable person makes in
a second. "Does this message convey urgency?" is such a question; "analyse this
and determine the best course of action" is not.

When a judgment depends on several independent factors, make each factor its own
question and combine the answers in your own code, with weights you control.
Changing a priority then means changing a coefficient, not rewriting a prompt.

Every question in a decider is evaluated in parallel and in isolation against
the same state, so adding questions barely changes the response time and one
question's answer is never hidden context for another. Asking a question you
might not need is close to free — evaluate it and let your code ignore the
answers that turned out not to matter.

### Answers

Answers are constrained to what you supplied: the model returns a distribution
over your options or levels, never a value outside them. A Choice maps onto
branches, a Score onto a threshold, a Noul onto an `if`.

`confidence` summarises how peaked a distribution is, and is a second axis from
the answer itself: the answer says *what*, confidence says whether to act on it
or escalate. A Noul has no separate confidence — its value is already a
probability, where near 0.5 means the model gives yes and no equal weight.

### State

The state is whatever is being judged: a string, or a JSON object whose parts
the questions address by path (`` Does `ticket.messages[0].text` request a
refund? ``). It is passed to the model as given.

The state is **not stored** on the decision. It is arbitrary caller content —
a ticket, a résumé, a message thread — and keeping it would put that content in
a table with no retention or purge path of its own. The answers are the durable
record; pair a decision with your own record of the input if you need both.

### Versioning

`version` starts at 1 and is incremented whenever `questions` is written.
Renaming a decider, or repointing it at another provider or model, leaves the
version alone.

Every decision names the `decider_version` that produced it, so a rubric level
reworded a month later never silently reinterprets last month's answers.

### Deletion

Deleting a decider keeps the decisions it produced. Each holds the decider's ID
as a dangling reference: the record still names what was evaluated, the same way
a [guardrail evaluation](./guardrails.md) outlives its guardrail.

## Errors

| Code                        | When                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `VALIDATION_FAILED`         | A malformed question set, a missing `state`, or a provider that is not `typesafe` |
| `AI_PROVIDER_NOT_FOUND`     | `ai_provider_id` names no provider in this project                    |
| `AI_PROVIDER_MISCONFIGURED` | The provider links no secret, so there is no API key to call with     |
| `AI_PROVIDER_ERROR`         | The provider was unreachable, rejected the request, or answered with a body carrying no usable value |
