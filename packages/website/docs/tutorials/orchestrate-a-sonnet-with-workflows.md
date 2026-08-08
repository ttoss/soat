---
description: "Compose a sonnet stanza by stanza through a Workflow — a chain of agent-driven states, a human review, a guarded publish, and a backward move a DAG would reject."
keywords:
  - agentic workflow
  - state machine
  - human review step
  - workflow states
  - task transitions
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
5. Send the card **backward** (`review → stanza_4`) for a fresh closing couplet — the cycle a DAG rejects.
6. **Guard** the publish transition, then close the task and read its full audited history.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) for projects, agents, and tasks.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Server at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available (or another [third-party LLM](/docs/tutorials/connect-third-party-llms)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples)
for authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project, provider, and agent

The [agent](/docs/modules/agents#examples) does one job: given a theme, write a
short sonnet. It is a normal agent — the workflow will call it, not the other way
around.

This tutorial uses a local Ollama provider so it can run without external
credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see
[Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Sonnet Workflow" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider ollama \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --name "Sonnet Writer" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --instructions "You are a poet. Given a theme, write a short sonnet about it. Reply with only the poem." | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Sonnet Workflow' },
});
const PROJECT_ID = project.id;

const { data: aiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});
const AI_PROVIDER_ID = aiProvider.id;

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    name: 'Sonnet Writer',
    ai_provider_id: AI_PROVIDER_ID,
    instructions:
      'You are a poet. Given a theme, write a short sonnet about it. Reply with only the poem.',
  },
});
const AGENT_ID = agent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Sonnet Workflow"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Local Ollama","provider":"ollama","default_model":"qwen2.5:0.5b"}' | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Sonnet Writer","ai_provider_id":"'"$AI_PROVIDER_ID"'","instructions":"You are a poet. Given a theme, write a short sonnet about it. Reply with only the poem."}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Define the workflow

Eight states model the card's life. The four composing states — `create_text` and
`stanza_1`…`stanza_4` — each carry `on_enter` automation: when the task enters one,
the workflow **dispatches the agent**, and on completion routes the card to the
next state. `create_text` turns the theme into a short plan; each stanza reads the
**poem-so-far** from `task.last_result.content` and asks the agent to
append the next quatrain, returning the whole poem — so the card carries the
growing sonnet forward. (An `on_enter` dispatch writes its output to
`last_result`; see [Workflows & Tasks](/docs/modules/workflows) for the
automation model.)

Each composing state also declares `on_failure`. Without it, a generation that
errors leaves the card parked in that state with no route out — the card simply
stops, and a reader waiting on forward progress has nothing to observe. Naming a
transition makes the failure a **move** instead of a stall: here every dispatch
state falls back to `abandon_to_review`, so a failed generation lands the card in
front of a human rather than nowhere.

`review` is a `human` state — the card parks there until a person acts.
`published` is `terminal`, so entering it closes the task.

The `publish` transition carries a **guard**: the card can only be published once
`payload.approved` is `true`.

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
      "on_complete": [ { "when": true, "transition": "to_stanza_1" } ],
      "on_failure": "abandon_to_review"
    }
  },
  { "name": "stanza_1",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Plan: ", { "var": "task.last_result.content" }, "\nWrite the FIRST quatrain (4 lines) of a sonnet about ", { "var": "task.payload.theme" }, ". Reply with only those 4 lines."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_2" } ],
      "on_failure": "abandon_to_review"
    }
  },
  { "name": "stanza_2",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Sonnet so far:\n", { "var": "task.last_result.content" }, "\nAppend the SECOND quatrain (4 more lines). Reply with the complete poem so far, nothing else."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_3" } ],
      "on_failure": "abandon_to_review"
    }
  },
  { "name": "stanza_3",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Sonnet so far:\n", { "var": "task.last_result.content" }, "\nAppend the THIRD quatrain (4 more lines). Reply with the complete poem so far, nothing else."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_stanza_4" } ],
      "on_failure": "abandon_to_review"
    }
  },
  { "name": "stanza_4",
    "on_enter": {
      "dispatch": {
        "kind": "agent",
        "agent_id": "'"$AGENT_ID"'",
        "input_mapping": {
          "prompt": { "cat": ["Sonnet so far:\n", { "var": "task.last_result.content" }, "\nWrite the closing COUPLET (2 final lines), replacing any couplet already there. Reply with the complete 14-line poem, nothing else."] }
        }
      },
      "on_complete": [ { "when": true, "transition": "to_review" } ],
      "on_failure": "abandon_to_review"
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
  { "name": "abandon_to_review",
    "from": ["create_text", "stanza_1", "stanza_2", "stanza_3", "stanza_4"],
    "to": "review" },
  { "name": "revise",      "from": ["review"],      "to": "stanza_4" },
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
<TabItem value="sdk" label="SDK">

```ts
const dispatchState = (args: {
  name: string;
  prompt: unknown;
  next: string;
}) => {
  return {
    name: args.name,
    on_enter: {
      dispatch: {
        kind: 'agent',
        agent_id: AGENT_ID,
        input_mapping: { prompt: args.prompt },
      },
      on_complete: [{ when: true, transition: args.next }],
      on_failure: 'abandon_to_review',
    },
  };
};

const { data: workflow } = await adminSoat.workflows.createWorkflow({
  body: {
    project_id: PROJECT_ID,
    name: 'Sonnet Pipeline',
    description:
      'A sonnet card composed stanza by stanza by an agent, reviewed by a human, guarded publish.',
    states: [
      { name: 'triage', initial: true },
      dispatchState({
        name: 'create_text',
        next: 'to_stanza_1',
        prompt: {
          cat: [
            'In two sentences, sketch the imagery and argument for a sonnet about ',
            { var: 'task.payload.theme' },
            '. Reply with only the plan.',
          ],
        },
      }),
      dispatchState({
        name: 'stanza_1',
        next: 'to_stanza_2',
        prompt: {
          cat: [
            'Plan: ',
            { var: 'task.last_result.content' },
            '\nWrite the FIRST quatrain (4 lines) of a sonnet about ',
            { var: 'task.payload.theme' },
            '. Reply with only those 4 lines.',
          ],
        },
      }),
      dispatchState({
        name: 'stanza_2',
        next: 'to_stanza_3',
        prompt: {
          cat: [
            'Sonnet so far:\n',
            { var: 'task.last_result.content' },
            '\nAppend the SECOND quatrain (4 more lines). Reply with the complete poem so far, nothing else.',
          ],
        },
      }),
      dispatchState({
        name: 'stanza_3',
        next: 'to_stanza_4',
        prompt: {
          cat: [
            'Sonnet so far:\n',
            { var: 'task.last_result.content' },
            '\nAppend the THIRD quatrain (4 more lines). Reply with the complete poem so far, nothing else.',
          ],
        },
      }),
      dispatchState({
        name: 'stanza_4',
        next: 'to_review',
        prompt: {
          cat: [
            'Sonnet so far:\n',
            { var: 'task.last_result.content' },
            '\nWrite the closing COUPLET (2 final lines), replacing any couplet already there. Reply with the complete 14-line poem, nothing else.',
          ],
        },
      }),
      { name: 'review', kind: 'human' },
      { name: 'published', terminal: true },
    ],
    transitions: [
      { name: 'start', from: ['triage'], to: 'create_text' },
      { name: 'to_stanza_1', from: ['create_text'], to: 'stanza_1' },
      { name: 'to_stanza_2', from: ['stanza_1'], to: 'stanza_2' },
      { name: 'to_stanza_3', from: ['stanza_2'], to: 'stanza_3' },
      { name: 'to_stanza_4', from: ['stanza_3'], to: 'stanza_4' },
      { name: 'to_review', from: ['stanza_4'], to: 'review' },
      {
        name: 'abandon_to_review',
        from: ['create_text', 'stanza_1', 'stanza_2', 'stanza_3', 'stanza_4'],
        to: 'review',
      },
      { name: 'revise', from: ['review'], to: 'stanza_4' },
      {
        name: 'publish',
        from: ['review'],
        to: 'published',
        guard: { '==': [{ var: 'task.payload.approved' }, true] },
      },
    ],
    payload_schema: { properties: { theme: { type: 'string' } } },
  },
});
const WORKFLOW_ID = workflow.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# The states/transitions JSON is identical to the CLI tab; keep it in shell
# variables so the request body stays readable.
WORKFLOW_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/workflows" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","name":"Sonnet Pipeline","states":'"$STATES"',"transitions":'"$TRANSITIONS"',"payload_schema":{"properties":{"theme":{"type":"string"}}}}' \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Create a task (a card)

The [task](/docs/modules/workflows#task) is placed in the `initial` state,
`triage`. Its `payload` carries the theme the agent will read.

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
<TabItem value="sdk" label="SDK">

```ts
const { data: task } = await adminSoat.tasks.createTask({
  body: {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    title: 'Sonnet: the sea',
    payload: { theme: 'the sea' },
  },
});
const TASK_ID = task.id;

const { data: created } = await adminSoat.tasks.getTask({
  path: { task_id: TASK_ID },
});
console.log(created.state, created.status); // triage open
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TASK_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","workflow_id":"'"$WORKFLOW_ID"'","title":"Sonnet: the sea","payload":{"theme":"the sea"}}' | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{ state, status }'
```

</TabItem>
</Tabs>

The card is `open` in `triage`.

---

## Step 5 — Advance the card; the agent composes the sonnet

Firing `start` moves the card into `create_text`, whose `on_enter` **dispatches the
agent**. From there the card walks the chain on its own: each state's `on_complete`
rule fires the next transition **as the `automation` principal**, re-entering a new
state that dispatches the agent again. While a generation runs the card shows
`automation_status: running`; the poem-so-far accumulates in `last_result`
until the card lands in `review`. See
[Per-state automation](/docs/modules/workflows#per-state-automation-on_enter).

Five generations run back to back, so the card takes a while to arrive. Rather
than hand-roll a polling loop, assert the destination and let the tutorial runner
retry: `# → retry N` re-runs the command until it exits `0`, up to `N` attempts a
second apart. `jq -e` supplies the exit code — non-zero until `.state` is
actually `review`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition start | jq '{ state, automation_status }'

# → retry 90
soat get-task --task-id "$TASK_ID" | jq -e '.state == "review"'

soat get-task --task-id "$TASK_ID" | jq '{ state, status, sonnet: .last_result.content }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'start' },
});

const waitForState = async (target: string) => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const { data: current } = await adminSoat.tasks.getTask({
      path: { task_id: TASK_ID },
    });
    if (current.state === target) return current;
    await new Promise((resolve) => {
      return setTimeout(resolve, 1000);
    });
  }
  throw new Error(`Task never reached ${target}`);
};

const reviewed = await waitForState('review');
console.log(reviewed.last_result?.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"start"}' | jq '{ state, automation_status }'

# Poll until the card finishes composing all four stanzas and parks in review.
until curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -e '.state == "review"' > /dev/null; do sleep 1; done

curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{ state, status, sonnet: .last_result.content }'
```

</TabItem>
</Tabs>

The card is now in `review`, holding the full sonnet it composed one stanza at a
time — no application-side state, no glue code between the stages.

---

## Step 6 — Send it backward for a revision

The reviewer wants a different ending. `review → stanza_4` is a **backward move** —
exactly the cycle a DAG rejects. Firing `revise` re-enters `stanza_4`, which
dispatches the agent once for a new closing couplet and routes the card back to
`review` through the same `to_review` transition it used the first time.

Note what a workflow makes cheap here: the revision re-enters the chain **at the
step that needs redoing**, not at the beginning. Pointing `revise` at
`create_text` instead would be equally valid and would recompose the whole poem —
five generations rather than one. Which state a rework transition targets is a
modelling decision, and it is the difference between a fast loop and a slow one.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition revise --note "tighten the closing couplet" | jq '{ state }'

# → retry 40
soat get-task --task-id "$TASK_ID" | jq -e '.state == "review"'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'revise', note: 'tighten the closing couplet' },
});

const revised = await waitForState('review');
console.log(revised.last_result?.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"revise","note":"tighten the closing couplet"}' | jq '{ state }'

until curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -e '.state == "review"' > /dev/null; do sleep 1; done
```

</TabItem>
</Tabs>

---

## Step 7 — Guarded publish

The `publish` transition's guard requires `payload.approved == true`. Firing it
before approving is **rejected** (`TASK_GUARD_REJECTED`) with no state change.
Approve via a payload patch, then publish — entering the `terminal` state closes
the task. [`PATCH /tasks/{task_id}`](/docs/modules/workflows#task) shallow-merges
the patch, so setting `approved` alone keeps the composed sonnet in
`last_result`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → 400
soat transition-task --task-id "$TASK_ID" --transition publish

soat update-task --task-id "$TASK_ID" --payload '{"approved":true}' | jq '{ approved: .payload.approved, sonnet_kept: (.last_result.content != null) }'

soat transition-task --task-id "$TASK_ID" --transition publish | jq '{ state, status }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
try {
  await adminSoat.tasks.transitionTask({
    path: { task_id: TASK_ID },
    body: { transition: 'publish' },
  });
} catch (error) {
  console.log('Rejected by the guard (approved is not set yet):', error);
}

await adminSoat.tasks.updateTask({
  path: { task_id: TASK_ID },
  body: { payload: { approved: true } },
});

const { data: published } = await adminSoat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'publish' },
});
console.log(published.state, published.status); // published closed
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Rejected by the guard (approved is not set yet).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"publish"}'

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"payload":{"approved":true}}' | jq '{ approved: .payload.approved, sonnet_kept: (.last_result.content != null) }'

curl -s -X POST "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/transitions" \
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
Automation-driven moves carry their `generation_id` as provenance. See
[Transition history](/docs/modules/workflows#transition-history).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-task-history --task-id "$TASK_ID" | jq -r '.[] | "\(.from_state // "∅") → \(.to_state)  [\(.principal_kind)]  \(.transition // "(initial)")"'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: history } = await adminSoat.tasks.getTaskHistory({
  path: { task_id: TASK_ID },
});
for (const entry of history) {
  console.log(
    `${entry.from_state ?? '∅'} → ${entry.to_state} [${entry.principal_kind}] ${entry.transition ?? '(initial)'}`
  );
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/tasks/$TASK_ID/history" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r '.[] | "\(.from_state // "∅") → \(.to_state)  [\(.principal_kind)]  \(.transition // "(initial)")"'
```

</TabItem>
</Tabs>

You will see the full trail, including the `automation`-principal stanza chain
(`create_text → stanza_1 → … → stanza_4 → review`) and the backward
`review → stanza_4` — the entity's whole life, audited.

## The board query

The workflow's states are the columns of a kanban board, and each task is a card.
One query renders a column, with no application-side state — see
[Tasks](/docs/modules/workflows#task):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-tasks --project-id "$PROJECT_ID" --workflow-id "$WORKFLOW_ID" --status closed | jq -r '.data[] | "\(.title): \(.state)"'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: board } = await adminSoat.tasks.listTasks({
  query: {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    status: 'closed',
  },
});
for (const card of board.data) {
  console.log(`${card.title}: ${card.state}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/tasks?project_id=$PROJECT_ID&workflow_id=$WORKFLOW_ID&status=closed" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data[] | "\(.title): \(.state)"'
```

</TabItem>
</Tabs>

## Where to go next

- [Workflows & Tasks](/docs/modules/workflows) — the full data model, guards, and automation reference.
- [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) — the same poem as a pipeline that ends, for contrast.
