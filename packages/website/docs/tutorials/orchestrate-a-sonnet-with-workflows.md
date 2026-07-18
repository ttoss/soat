---
description: "Drive a sonnet through a Workflow — agent-driven states, a human review, a guarded publish, and a backward move a DAG would reject."
sidebar_position: 11
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Write a Sonnet with a Workflow

The [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) tutorial builds
a **pipeline that ends** — a DAG that runs forward and terminates. This tutorial
builds the same sonnet, but as a **[workflow](/docs/modules/workflows) a
[task](/docs/modules/workflows) lives in**: a card that moves between named states,
that an agent advances on its own, that a human reviews, and that can move
**backward** for a revision — the case a DAG rejects by design.

> An orchestration is a pipeline that ends. A workflow is a state graph a task
> lives in. When a task enters a state, that state may _dispatch_ an agent (or an
> orchestration) to do its work.

You will:

1. Create a project, an AI provider, and a sonnet-writing [agent](/docs/modules/agents#examples).
2. Define a [workflow](/docs/modules/workflows): `triage → drafting → review → published`.
3. Wire the `drafting` state's `on_enter` to **dispatch the agent** and route its result onward.
4. Create a [task](/docs/modules/workflows) and watch the card advance itself.
5. Send the card **backward** (`review → drafting`) for a revision — re-running the agent.
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

Four states model the card's life. `drafting` carries `on_enter` automation: when
a task enters it, the workflow **dispatches the agent**, mapping the task's
`theme` payload into the prompt, and on completion routes the card to `review`.
`review` is a `human` state — the card parks there until a person acts.
`published` is `terminal`, so entering it closes the task.

The `publish` transition carries a **guard**: the card can only be published once
`payload.approved` is `true`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STATES='[
  { "name": "triage", "initial": true },
  { "name": "drafting",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Write a sonnet about ", { "var": "task.payload.theme" }] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_review" } ]
    }
  },
  { "name": "review", "kind": "human" },
  { "name": "published", "terminal": true }
]'

TRANSITIONS='[
  { "name": "start",     "from": ["triage"],   "to": "drafting" },
  { "name": "to_review", "from": ["drafting"], "to": "review" },
  { "name": "revise",    "from": ["review"],   "to": "drafting" },
  { "name": "publish",   "from": ["review"],   "to": "published",
    "guard": { "==": [{ "var": "task.payload.approved" }, true] } }
]'

WORKFLOW_ID=$(soat create-workflow \
  --project-id "$PROJECT_ID" \
  --name "Sonnet Pipeline" \
  --description "A sonnet card: draft by agent, review by human, guarded publish." \
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
      {\"name\":\"drafting\",\"on_enter\":{\"dispatch\":{\"kind\":\"agent\",\"agent_id\":\"$AGENT_ID\",\"input_mapping\":{\"prompt\":{\"cat\":[\"Write a sonnet about \",{\"var\":\"task.payload.theme\"}]}}},\"on_complete\":[{\"when\":true,\"transition\":\"to_review\"}]}},
      {\"name\":\"review\",\"kind\":\"human\"},
      {\"name\":\"published\",\"terminal\":true}
    ],
    \"transitions\": [
      {\"name\":\"start\",\"from\":[\"triage\"],\"to\":\"drafting\"},
      {\"name\":\"to_review\",\"from\":[\"drafting\"],\"to\":\"review\"},
      {\"name\":\"revise\",\"from\":[\"review\"],\"to\":\"drafting\"},
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

## Step 5 — Advance the card; the agent writes the sonnet

Firing `start` moves the card into `drafting`, whose `on_enter` **dispatches the
agent**. While the generation runs the card shows `automation_status: running`;
when it completes, the `on_complete` rule fires `to_review` **as the `automation`
actor**, and the sonnet lands in `payload.last_result`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition start | jq '{ state, automation_status }'

for i in $(seq 1 30); do STATE=$(soat get-task --task-id "$TASK_ID" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" != "drafting" ] && break; sleep 2; done

soat get-task --task-id "$TASK_ID" | jq '{ state, status, sonnet: .payload.last_result.content }'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"start"}' | jq '{ state, automation_status }'

# Poll until the agent finishes and the card advances to review.
for i in $(seq 1 30); do STATE=$(curl -s "$SOAT_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" != "drafting" ] && break; sleep 2; done
```

</TabItem>
</Tabs>

The card is now in `review`, holding the generated sonnet — no application-side
state, no glue code.

---

## Step 6 — Send it backward for a revision

A human is not happy with the draft. `review → drafting` is a **backward move** —
exactly the cycle a DAG rejects. Firing `revise` re-enters `drafting`, which
**re-dispatches the agent** for a fresh draft, then routes back to `review`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition revise --note "tighten the imagery" | jq '{ state }'

for i in $(seq 1 30); do STATE=$(soat get-task --task-id "$TASK_ID" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" != "drafting" ] && break; sleep 2; done
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"revise","note":"tighten the imagery"}' | jq '{ state }'

for i in $(seq 1 30); do STATE=$(curl -s "$SOAT_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.state'); echo "poll: state=$STATE"; [ "$STATE" != "drafting" ] && break; sleep 2; done
```

</TabItem>
</Tabs>

---

## Step 7 — Guarded publish

The `publish` transition's guard requires `payload.approved == true`. Firing it
before approving is **rejected** (`TASK_GUARD_REJECTED`) with no state change.
Approve via a payload patch, then publish — entering the `terminal` state closes
the task.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition publish
# → 400

soat update-task --task-id "$TASK_ID" --payload '{"theme":"the sea","approved":true}' | jq '{ approved: .payload.approved }'

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
  -d '{"payload":{"theme":"the sea","approved":true}}' | jq '{ approved: .payload.approved }'

curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"publish"}' | jq '{ state, status }'
```

</TabItem>
</Tabs>

The card is `published` and `closed`.

---

## Step 8 — Read the audited history

Every move — the human `start`, the agent's `to_review`, the backward `revise`,
the guarded `publish` — is one append-only record. Automation-driven moves carry
their `generation_id` as provenance.

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

You will see the full trail, including the `automation`-actor `to_review` moves
and the backward `review → drafting` — the entity's whole life, audited.

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
