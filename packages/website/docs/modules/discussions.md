---
description: "Reusable deliberation configs where a panel of participants thinks over a topic and returns a synthesized outcome."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Discussions

Reusable deliberation configs whose invocations are runs — a panel of participants thinks over a topic and returns a synthesized outcome.

## Overview

A **Discussion** is the home of deep thinking in SOAT. It is a reusable configuration (who deliberates and how); each invocation is a **DiscussionRun** (what was deliberated and what came out) — the same split as an [Agent](./agents.md) and its generations. Author a discussion once, then invoke it many times: standalone (brainstorming, red-teaming, expert review) or, more commonly, from an agent mid-loop via a `discussion`-type [tool](./tools.md#discussion).

Deep thinking lives entirely in Discussions rather than in a per-agent `reasoning` config. If you are porting a `reasoning` recipe, see [Migrating from agent reasoning](#migrating-from-agent-reasoning).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Review Panel - step 4 (Create the review-panel discussion)](/docs/tutorials/review-panel-discussion) — a writer agent drafts text, then a discussion checks its fundamentals and voice/tone.

## Data Model

### Discussion

| Field            | Type     | Description                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `id`             | string   | Unique identifier (`disc_` prefix)                                          |
| `project_id`     | string   | Project the discussion belongs to                                           |
| `name`           | string   | Display name                                                                |
| `description`    | string   | Optional description                                                        |
| `ai_provider_id` | string   | Default AI provider participants and synthesis fall back to (**required**)  |
| `model`          | string   | Default model (falls back to the provider's `default_model`)                |
| `max_rounds`     | number   | Rounds of deliberation (1–3, default `1`)                                   |
| `synthesis`      | object   | Optional override for the final synthesis pass — see [Synthesis](#synthesis) |
| `participants`   | array    | The deliberation participants — see [Participant](#participant)             |
| `template_warnings` | array | Read-only. Non-blocking warnings for participant/synthesis `prompt` `{token}` references outside the allowlist described in [Expressions & Templating](../advanced/expressions-and-templating.md#discussion-prompt-tokens). Unknown tokens are not rejected — they pass through unresolved — so this is informational only. |
| `tags`           | object   | Arbitrary string tags                                                       |
| `created_at`     | string   | ISO 8601 creation timestamp                                                 |
| `updated_at`     | string   | ISO 8601 last-updated timestamp                                             |

### Participant

Each participant is one voice in the deliberation. A discussion allows 1–5 participants.

| Field            | Type   | Description                                                             |
| ---------------- | ------ | ---------------------------------------------------------------------- |
| `id`             | string | Unique identifier (`dpt_` prefix)                                      |
| `name`           | string | Display label used for transcript attribution                         |
| `prompt`         | string | Persona prompt for this participant                                   |
| `position`       | number | Turn order (defaults to array index)                                  |
| `actor_id`       | string | Durable [Actor](./actors.md) identity to attribute this voice's turns to |
| `ai_provider_id` | string | Provider override for this participant (falls back to the discussion) |
| `model`          | string | Model override                                                        |
| `temperature`    | number | Sampling temperature                                                  |
| `effort`         | string | `low` \| `medium` \| `high` — provider-native reasoning effort for this participant's turns |

### DiscussionRun

A run is a single invocation of a discussion.

| Field                     | Type        | Description                                                        |
| ------------------------- | ----------- | ------------------------------------------------------------------ |
| `id`                      | string      | Unique identifier (`drn_` prefix)                                  |
| `discussion_id`           | string      | Discussion that was invoked                                        |
| `project_id`              | string      | Project the run belongs to                                         |
| `topic`                   | string      | The subject the participants deliberated on (the invocation argument) |
| `status`                  | string      | `pending` \| `running` \| `completed` \| `failed`                  |
| `outcome`                 | string/null | The synthesized outcome text (the tool-result contract)            |
| `conversation_id`         | string/null | The persisted transcript as a [Conversation](./conversations.md)   |
| `outcome_document_id`     | string/null | The stored outcome as a [Document](./documents.md)                 |
| `started_by`              | object/null | Identity that triggered the run                                    |
| `initiator_generation_id` | string/null | Generation that invoked this run (when triggered by an agent tool) |
| `trace_id`                | string/null | Associated trace ID                                                |
| `completed_at`            | string/null | ISO 8601 completion timestamp                                      |
| `created_at`              | string      | ISO 8601 creation timestamp                                        |

## Key Concepts

### Deliberation and synthesis

A run maps each participant to a voice in a single deliberation step that runs for `max_rounds` rounds; every voice sees the running transcript. When there is more than one participant, more than one round, or an explicit `synthesis` config, a final **synthesis** pass weighs the deliberation into a single `outcome`. A single-participant, single-round discussion with no `synthesis` skips the extra pass — its lone turn *is* the outcome.

Each turn is a side-effect-free completion (no tools). Deep thinking never fails a run: a failed turn is dropped and the run continues; if synthesis fails, the last successful turn becomes the outcome.

### Synthesis

The optional `synthesis` object overrides the final pass:

| Field            | Type   | Description                                             |
| ---------------- | ------ | ------------------------------------------------------- |
| `ai_provider_id` | string | Provider for the synthesis completion                  |
| `model`          | string | Model for the synthesis completion                     |
| `prompt`         | string | Synthesis prompt template (supports `{steps.deliberation}` and `{topic}`) |
| `effort`         | string | `low` \| `medium` \| `high` provider-native effort      |

### Invoking a discussion from an agent

An agent thinks by attaching a **`discussion`-type tool** that references a discussion config (`{ "type": "discussion", "discussion": { "discussion_id": "disc_..." } }`). The model calls it mid-loop with a `topic`; the server runs the discussion synchronously and returns `{ outcome, run_id }` as the tool result. Use `tool_choice: required` or a step rule to force "discuss before acting". See [`discussion` tools](./tools.md#discussion).

The full transcript and outcome persist on the run (Conversation + Document); the tool result carries only the synthesized `outcome` plus the `run_id`, so it never floods the caller's context.

### Migrating from agent reasoning

> **Migration note.** Earlier versions exposed a `reasoning` config on the agent (provider-native effort **and** a reasoning-step pipeline). Discussions replace it.

The agent schema has no `reasoning` field: agent create/update and per-generation overrides that include it are rejected with a `400` (unknown field). Map each reasoning recipe to a discussion:

| Former agent `reasoning`                    | Discussion equivalent                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `reflect` (draft → critique → revise)       | A single-participant discussion with a `synthesis` prompt that critiques and revises |
| `debate` (multi-perspective + synthesis)    | Multiple participants (one per perspective) + a synthesis pass; set `max_rounds` for rebuttal rounds |
| `best-of-N` (independent samples + judge)   | Multiple participants with varied `temperature` + a synthesis pass that picks/merges |
| `reasoning.effort`                          | `effort` on a participant and/or the `synthesis` override                         |

Invoke the discussion from the agent via a `discussion`-type tool, or call `POST /discussions/{id}/runs` before/after a generation. No data migration is required — the old `reasoning` config simply stops being read.

## Examples

### Create a discussion

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-discussion \
  --project-id proj_ABC \
  --name "Design review panel" \
  --ai-provider-id aip_01 \
  --max-rounds 2 \
  --participants '[{"name":"Advocate","prompt":"Steelman the proposal."},{"name":"Skeptic","prompt":"Attack the strongest claim."}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.discussions.createDiscussion({
  body: {
    project_id: 'proj_ABC',
    name: 'Design review panel',
    ai_provider_id: 'aip_01',
    max_rounds: 2,
    participants: [
      { name: 'Advocate', prompt: 'Steelman the proposal.' },
      { name: 'Skeptic', prompt: 'Attack the strongest claim.' },
    ],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/discussions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Design review panel",
    "ai_provider_id": "aip_01",
    "max_rounds": 2,
    "participants": [
      { "name": "Advocate", "prompt": "Steelman the proposal." },
      { "name": "Skeptic", "prompt": "Attack the strongest claim." }
    ]
  }'
```

</TabItem>
</Tabs>

### Run a discussion

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-discussion-run \
  --discussion-id disc_01 \
  --topic "Should we migrate the queue to Kafka?"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.discussions.createDiscussionRun({
  path: { discussion_id: 'disc_01' },
  body: { topic: 'Should we migrate the queue to Kafka?' },
});
if (error) throw new Error(JSON.stringify(error));
console.log(data?.outcome);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/discussions/disc_01/runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "topic": "Should we migrate the queue to Kafka?" }'
```

</TabItem>
</Tabs>
