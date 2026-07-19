---
description: "Compose a sonnet stanza by stanza through a Workflow — a chain of agent-driven states, a human review, a guarded publish, and a backward move a DAG would reject."
sidebar_position: 11
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Write a Sonnet with a Workflow

The [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) tutorial builds
a **pipeline that ends** — a DAG that runs forward and terminates. This tutorial
builds the same sonnet, but as a **[workflow](/docs/modules/workflows) a
[task](/docs/modules/workflows) lives in**: a card that moves through a chain of
named states, that an agent advances on its own, that a human reviews, and that
can move **backward** for a revision — the case a DAG rejects by design.

Rather than draft the whole poem in one shot, the card is built **one stanza at a
time**: a state per stanza, each dispatching the agent to append the next
quatrain — a Shakespearean sonnet is three quatrains and a closing couplet, four
stanzas in all. Every state hands the poem-so-far to the next through the task
payload, so the card carries the growing sonnet as it advances itself.

> An orchestration is a pipeline that ends. A workflow is a state graph a task
> lives in. When a task enters a state, that state may _dispatch_ an agent (or an
> orchestration) to do its work, then route the card onward.

You will:

1. Create a project, an AI provider, and a sonnet-writing [agent](/docs/modules/agents#examples).
2. Define a [workflow](/docs/modules/workflows): `triage → create_text → stanza_1 → stanza_2 → stanza_3 → stanza_4 → review → published`.
3. Wire each composing state's `on_enter` to **dispatch the agent**, feed it the poem-so-far, and route the result to the next stanza.
4. Create a [task](/docs/modules/workflows) and watch the card compose itself stanza by stanza.
5. Send the card **backward** (`review → create_text`) for a revision — re-running the whole chain.
6. **Guard** the publish transition, then close the task and read its full audited history.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Server at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available (or another [third-party LLM](/docs/tutorials/connect-third-party-llms)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project, provider, and agent

The agent does one job: given a theme, write a short sonnet. It is a normal
agent — the workflow will call it, not the other way around.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Sonnet Workflow" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider ollama \
  --default-model llama3.2 | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --name "Sonnet Writer" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --instructions "You are a poet. Given a theme, write a short sonnet about it. Reply with only the poem." | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Sonnet Workflow"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"llama3.2\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Sonnet Writer\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"instructions\":\"You are a poet. Given a theme, write a short sonnet. Reply with only the poem.\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Define the workflow

Eight states model the card's life. The four composing states — `create_text` and
`stanza_1`…`stanza_4` — each carry `on_enter` automation: when the task enters one,
the workflow **dispatches the agent**, and on completion routes the card to the
next state. `create_text` turns the theme into a short plan; each stanza reads the
**poem-so-far** from `task.payload.last_result.content` and asks the agent to
append the next quatrain, returning the whole poem — so the card carries the
growing sonnet forward. (An `on_enter` dispatch writes its output to
`payload.last_result`; see [Workflows & Tasks](/docs/modules/workflows) for the
automation model.)

`review` is a `human` state — the card parks there until a person acts.
`published` is `terminal`, so entering it closes the task.

The `publish` transition carries a **guard**: the card can only be published once
`payload.approved` is `true`. This tutorial uses a local Ollama provider so it can
run without external credentials; to connect xAI, OpenAI, Anthropic, or Amazon
Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STATES='[
  { "name": "triage", "initial": true },
  { "name": "create_text",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["In two sentences, sketch the imagery and argument for a sonnet about ", { "var": "task.payload.theme" }, ". Reply with only the plan."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_1" } ]
    }
  },
  { "name": "stanza_1",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Plan: ", { "var": "task.payload.last_result.content" }, "\nWrite the FIRST quatrain (4 lines) of a sonnet about ", { "var": "task.payload.theme" }, ". Reply with only those 4 lines."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_2" } ]
    }
  },
  { "name": "stanza_2",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Sonnet so far:\n", { "var": "task.payload.last_result.content" }, "\nAppend the SECOND quatrain (4 more lines). Reply with the complete poem so far, nothing else."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_3" } ]
    }
  },
  { "name": "stanza_3",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Sonnet so far:\n", { "var": "task.payload.last_result.content" }, "\nAppend the THIRD quatrain (4 more lines). Reply with the complete poem so far, nothing else."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_4" } ]
    }
  },
  { "name": "stanza_4",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Sonnet so far:\n", { "var": "task.payload.last_result.content" }, "\nAppend the closing COUPLET (2 final lines). Reply with the complete 14-line poem, nothing else."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_review" } ]
    }
  },
  { "name": "review", "kind": "human" },
  { "name": "published", "terminal": true }
]'

TRANSITIONS='[
  { "name": "start",       "from": ["triage"],      "to": "create_text" },
  { "name": "to_stanza_1", "from": ["create_text"], "to": "stanza_1" },
  { "name": "to_stanza_2", "from": ["stanza_1"],    "to": "stanza_2" },
  { "name": "to_stanza_3", "from": ["stanza_2"],    "to": "stanza_3" },
  { "name": "to_stanza_4", "from": ["stanza_3"],    "to": "stanza_4" },
  { "name": "to_review",   "from": ["stanza_4"],    "to": "review" },
  { "name": "revise",      "from": ["review"],      "to": "create_text" },
  { "name": "publish",     "from": ["review"],      "to": "published",
    "guard": { "==": [{ "var": "task.payload.approved" }, true] } }
]'

WORKFLOW_ID=$(soat create-workflow \
  --project-id "$PROJECT_ID" \
  --name "Sonnet Pipeline" \
  --description "A sonnet card composed stanza by stanza by an agent, reviewed by a human, guarded publish." \
  --states "$STATES" \
  --transitions "$TRANSITIONS" \
  --payload-schema '{"properties":{"theme":{"type":"string"}}}' | jq -r '.id')
echo "WORKFLOW_ID: $WORKFLOW_ID"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WORKFLOW_ID=$(curl -s -X POST "$SOAT_URL/api/v1/workflows" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"Sonnet Pipeline\",
    \"states\": [
      {\"name\":\"triage\",\"initial\":true},
      {\"name\":\"create_text\",\"on_enter\":{\"dispatch\":{\"kind\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"input_mapping\":{\"prompt\":{\"cat\":[\"In two sentences, sketch the imagery and argument for a sonnet about \",{\"var\":\"task.payload.theme\"},\". Reply with only the plan.\"]}}},\"on_complete\":[{\"when\":true,\"transition\":\"to_stanza_1\"}]}},
      {\"name\":\"stanza_1\",\"on_enter\":{\"dispatch\":{\"kind\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"input_mapping\":{\"prompt\":{\"cat\":[\"Plan: \",{\"var\":\"task.payload.last_result.content\"},\"\\nWrite the FIRST quatrain (4 lines) of a sonnet about \",{\"var\":\"task.payload.theme\"},\". Reply with only those 4 lines.\"]}}},\"on_complete\":[{\"when\":true,\"transition\":\"to_stanza_2\"}]}},
      {\"name\":\"stanza_2\",\"on_enter\":{\"dispatch\":{\"kind\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"input_mapping\":{\"prompt\":{\"cat\":[\"Sonnet so far:\\n\",{\"var\":\"task.payload.last_result.content\"},\"\\nAppend the SECOND quatrain (4 more lines). Reply with the complete poem so far, nothing else.\"]}}},\"on_complete\":[{\"when\":true,\"transition\":\"to_stanza_3\"}]}},
      {\"name\":\"stanza_3\",\"on_enter\":{\"dispatch\":{\"kind\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"input_mapping\":{\"prompt\":{\"cat\":[\"Sonnet so far:\\n\",{\"var\":\"task.payload.last_result.content\"},\"\\nAppend the THIRD quatrain (4 more lines). Reply with the complete poem so far, nothing else.\"]}}},\"on_complete\":[{\"when\":true,\"transition\":\"to_stanza_4\"}]}},
      {\"name\":\"stanza_4\",\"on_enter\":{\"dispatch\":{\"kind\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"input_mapping\":{\"prompt\":{\"cat\":[\"Sonnet so far:\\n\",{\"var\":\"task.payload.last_result.content\"},\"\\nAppend the closing COUPLET (2 final lines). Reply with the complete 14-line poem, nothing else.\"]}}},\"on_complete\":[{\"when\":true,\"transition\":\"to_review\"}]}},
      {\"name\":\"review\",\"kind\":\"human\"},
      {\"name\":\"published\",\"terminal\":true}
    ],
    \"transitions\": [
      {\"name\":\"start\",\"from\":[\"triage\"],\"to\":\"create_text\"},
      {\"name\":\"to_stanza_1\",\"from\":[\"create_text\"],\"to\":\"stanza_1\"},
      {\"name\":\"to_stanza_2\",\"from\":[\"stanza_1\"],\"to\":\"stanza_2\"},
      {\"name\":\"to_stanza_3\",\"from\":[\"stanza_2\"],\"to\":\"stanza_3\"},
      {\"name\":\"to_stanza_4\",\"from\":[\"stanza_3\"],\"to\":\"stanza_4\"},
      {\"name\":\"to_review\",\"from\":[\"stanza_4\"],\"to\":\"review\"},
      {\"name\":\"revise\",\"from\":[\"review\"],\"to\":\"create_text\"},
      {\"name\":\"publish\",\"from\":[\"review\"],\"to\":\"published\",\"guard\":{\"==\":[{\"var\":\"task.payload.approved\"},true]}}
    ],
    \"payload_schema\": {\"properties\":{\"theme\":{\"type\":\"string\"}}}
  }" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Create a task (a card)

The task is placed in the `initial` state, `triage`. Its `payload` carries the
theme the agent will read.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TASK_ID=$(soat create-task \
  --project-id "$PROJECT_ID" \
  --workflow-id "$WORKFLOW_ID" \
  --title "Sonnet: the sea" \
  --payload '{"theme":"the sea"}' | jq -r '.id')
echo "TASK_ID: $TASK_ID"

soat get-task --task-id "$TASK_ID" | jq '{ state, status }'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TASK_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tasks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"workflow_id\":\"$WORKFLOW_ID\",\"title\":\"Sonnet: the sea\",\"payload\":{\"theme\":\"the sea\"}}" | jq -r '.id')

curl -s "$SOAT_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{ state, status }'
```

</TabItem>
</Tabs>

The card is `open` in `triage`.

---

## Step 5 — Advance the card; the agent composes the sonnet

Firing `start` moves the card into `create_text`, whose `on_enter` **dispatches the
agent**. From there the card walks the chain on its own: each state's `on_complete`
rule fires the next transition **as the `automation` actor**, re-entering a new
state that dispatches the agent again. While a generation runs the card shows
`automation_status: running`; the poem-so-far accumulates in `payload.last_result`
until the card lands in `review`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition start | jq '{ state, automation_status }'

# Poll until the card finishes composing and parks in the human review state.
for i in $(seq 1 60); do STATE=$(soat get-task --task-id "$TASK_ID" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" = "review" ] && break; [ "$STATE" = "published" ] && break; sleep 2; done

soat get-task --task-id "$TASK_ID" | jq '{ state, status, sonnet: .payload.last_result.content }'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"start"}' | jq '{ state, automation_status }'

# Poll until the card finishes composing all four stanzas and parks in review.
for i in $(seq 1 60); do STATE=$(curl -s "$SOAT_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" = "review" ] && break; [ "$STATE" = "published" ] && break; sleep 2; done
```

</TabItem>
</Tabs>

The card is now in `review`, holding the full sonnet it composed one stanza at a
time — no application-side state, no glue code between the stages.

---

## Step 6 — Send it backward for a revision

A human is not happy with the draft. `review → create_text` is a **backward move** —
exactly the cycle a DAG rejects. Firing `revise` re-enters `create_text`, and the
card composes a fresh sonnet through the whole chain again, ending back in
`review`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition revise --note "tighten the imagery" | jq '{ state }'

for i in $(seq 1 60); do STATE=$(soat get-task --task-id "$TASK_ID" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" = "review" ] && break; [ "$STATE" = "published" ] && break; sleep 2; done
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"revise","note":"tighten the imagery"}' | jq '{ state }'

for i in $(seq 1 60); do STATE=$(curl -s "$SOAT_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" = "review" ] && break; [ "$STATE" = "published" ] && break; sleep 2; done
```

</TabItem>
</Tabs>

---

## Step 7 — Guarded publish

The `publish` transition's guard requires `payload.approved == true`. Firing it
before approving is **rejected** (`TASK_GUARD_REJECTED`) with no state change.
Approve via a payload patch, then publish — entering the `terminal` state closes
the task. [`PATCH /tasks/{id}`](/docs/modules/workflows) shallow-merges the
patch, so setting `approved` alone keeps the composed sonnet in
`payload.last_result`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition publish
# → 400

soat update-task --task-id "$TASK_ID" --payload '{"approved":true}' | jq '{ approved: .payload.approved, sonnet_kept: (.payload.last_result.content != null) }'

soat transition-task --task-id "$TASK_ID" --transition publish | jq '{ state, status }'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Rejected by the guard (approved is not set yet).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"publish"}'

curl -s -X PATCH "$SOAT_URL/api/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"payload":{"approved":true}}' | jq '{ approved: .payload.approved, sonnet_kept: (.payload.last_result.content != null) }'

curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"publish"}' | jq '{ state, status }'
```

</TabItem>
</Tabs>

The card is `published` and `closed`.

---

## Step 8 — Read the audited history

Every move — the human `start`, the agent's `to_stanza_1`…`to_review` chain, the
backward `revise`, the guarded `publish` — is one append-only record.
Automation-driven moves carry their `generation_id` as provenance.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-task-history --task-id "$TASK_ID" | jq -r '.[] | "\(.from_state // "∅") → \(.to_state)  [\(.actor_kind)]  \(.transition // "(initial)")"'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/tasks/$TASK_ID/history" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r '.[] | "\(.from_state // "∅") → \(.to_state)  [\(.actor_kind)]  \(.transition // "(initial)")"'
```

</TabItem>
</Tabs>

You will see the full trail, including the `automation`-actor stanza chain
(`create_text → stanza_1 → … → stanza_4 → review`) and the backward
`review → create_text` — the entity's whole life, audited.

## The board query

The workflow's states are the columns of a kanban board, and each task is a card.
One query renders a column, with no application-side state:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-tasks --project-id "$PROJECT_ID" --workflow-id "$WORKFLOW_ID" --status closed | jq -r '.[] | "\(.title): \(.state)"'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/tasks?project_id=$PROJECT_ID&workflow_id=$WORKFLOW_ID&status=closed" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.[] | "\(.title): \(.state)"'
```

</TabItem>
</Tabs>

## Where to go next

- [Workflows & Tasks](/docs/modules/workflows) — the full data model, guards, and automation reference.
- [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) — the same poem as a pipeline that ends, for contrast.
- Give an agent `tasks:TransitionTask` and it can move cards itself through the [MCP surface](/docs/modules/workflows) — the agentic kanban.
