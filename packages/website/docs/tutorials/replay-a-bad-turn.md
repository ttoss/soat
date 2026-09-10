---
description: 'Take one bad answer from production and close the loop on it: read the turn back step by step, freeze it as an eval fixture, fork the session at that message, and re-run the same context against a different agent.'
keywords:
  - session forking
  - replay agent turn
  - generation transcript
  - curate dataset from production
  - AI regression testing
  - debug agent answer
sidebar_position: 29
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Replay a Bad Turn

An agent gave a bad answer at message 3 of a real conversation. Try a stricter prompt against **that exact context**, and turn the bad answer into a test case. Three operations compose into one loop:

| Operation                             | What it gives you                                                |
| ------------------------------------- | ---------------------------------------------------------------- |
| `get-generation-transcript`           | the turn read back step by step — what was asked, what it did    |
| `create-dataset-item-from-generation` | that turn frozen as an [eval](/docs/modules/evaluations) fixture |
| `fork-session`                        | a new session branched at any message, same context              |

You will produce a bad turn, read it back, capture it, branch the session at the customer's question, answer with a different agent, and score the result against the fixture. Assumes [Evaluate an Agent](/docs/tutorials/evaluate-an-agent).

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)).
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b`. For xAI, OpenAI, Anthropic, or Amazon Bedrock, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- [Key Concepts](/docs/getting-started/concepts) if new to SOAT.
- [CLI](/docs/cli) or [SDK](/docs/sdk) set up.
- [Configuration](/docs/self-hosting/configuration) for production hardening.

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

Admin is the built-in superuser role ([Users](/docs/modules/users#examples)).

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

## Step 2 — Produce the turn that goes wrong

A support drafter with vague instructions; the customer's second message asks the question that matters ([Sessions](/docs/modules/sessions)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Replay Workshop" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Drafter" \
  --instructions "Reply to the customer in one short sentence." | jq -r '.id')

SESSION=$(soat create-session --agent-id "$AGENT_ID" --name "ticket-4471")
SESSION_ID=$(printf '%s' "$SESSION" | jq -r '.id')
CONVERSATION_ID=$(printf '%s' "$SESSION" | jq -r '.conversation_id')

soat add-session-message --session-id "$SESSION_ID" \
  --message "Hi, my order 4471 arrived with a cracked screen."
soat generate-session-response --session-id "$SESSION_ID" --wait true | jq '.status'

soat add-session-message --session-id "$SESSION_ID" \
  --message "So what do I do now? Do I get a refund or not?"
GENERATION_ID=$(soat generate-session-response --session-id "$SESSION_ID" --wait true | jq -r '.generation_id')

soat list-conversation-messages --conversation-id "$CONVERSATION_ID" \
  | jq '.data | map({position, role, document_id})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Replay Workshop' },
});

const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: project.id,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: project.id,
    ai_provider_id: provider.id,
    name: 'Support Drafter',
    instructions: 'Reply to the customer in one short sentence.',
  },
});

const { data: session } = await adminSoat.sessions.createSession({
  body: { agent_id: agent.id, name: 'ticket-4471' },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: session.id },
  body: { message: 'Hi, my order 4471 arrived with a cracked screen.' },
});
await adminSoat.sessions.generateSessionResponse({
  path: { session_id: session.id },
  query: { wait: true },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: session.id },
  body: { message: 'So what do I do now? Do I get a refund or not?' },
});
const { data: turn } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: session.id },
  query: { wait: true },
});
console.log(turn.generation_id);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Replay Workshop"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Drafter\",\"instructions\":\"Reply to the customer in one short sentence.\"}" | jq -r '.id')

SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"name\":\"ticket-4471\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

Four messages, each backed by a [Document](/docs/modules/documents); the fork will share these `document_id` values:

```json
[
  { "position": 0, "role": "user", "document_id": "doc_xhKfqZS0h81cSgaW" },
  { "position": 1, "role": "assistant", "document_id": "doc_opF0s5dnVb0iISJT" },
  { "position": 2, "role": "user", "document_id": "doc_YySNY6X8dUvUaoP0" },
  { "position": 3, "role": "assistant", "document_id": "doc_hKyysHRAWkdkmcyq" }
]
```

Position 3 is the answer that ducked the refund question.

---

## Step 3 — Read the turn back

A [transcript](/docs/modules/generations) is the turn reconstructed at read time from the generation record and the trace's steps: the input messages, each model step with its tool calls and results, and the final answer. It is never stored, so a [retention](/docs/modules/traces#retention-policy) purge erases it with the content it projects.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-generation-transcript --generation-id "$GENERATION_ID" \
  | jq '{generation_id, agent_id, agent_version, status, step_count,
         asked: (.input | length),
         steps: (.steps | map({index, finish_reason, tool_calls: (.tool_calls | length)})),
         output}'

soat get-generation-transcript --generation-id "$GENERATION_ID" | jq -e '.status == "completed"'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: transcript } =
  await adminSoat.generations.getGenerationTranscript({
    path: { generation_id: turn.generation_id },
  });

console.log(transcript.step_count, transcript.output?.content);
for (const step of transcript.steps) {
  console.log(step.index, step.finish_reason, step.tool_calls.length);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/generations/$GENERATION_ID/transcript" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, step_count, output}'
```

</TabItem>
</Tabs>

```json
{
  "generation_id": "gen_SlTCmreS0pKemdOU",
  "agent_id": "agent_aM5RVDxV9EJZpZzu",
  "agent_version": 1,
  "status": "completed",
  "step_count": 1,
  "asked": 4,
  "steps": [{ "index": 0, "finish_reason": "stop", "tool_calls": 0 }],
  "output": { "content": "…", "finish_reason": "stop" }
}
```

`agent_version` is the config that served the turn; `step_count` survives a purge even when `steps` is empty; `status` distinguishes an empty transcript from a run in flight from one with erased content. Tool calls appear per step.

---

## Step 4 — Freeze the turn as a fixture

Curating from a real generation copies the turn's input, and its output as `expected_output` unless you supply one, into a [dataset item](/docs/modules/evaluations#dataset) that records its provenance. Here the recorded answer is the bad one, so pass the wanted answer:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DATASET_ID=$(soat create-dataset --project-id "$PROJECT_ID" --name "support-regressions" | jq -r '.id')

ITEM=$(soat create-dataset-item-from-generation \
  --dataset-id "$DATASET_ID" \
  --generation-id "$GENERATION_ID" \
  --expected-output "Apologize, confirm the refund, and give the timeline.")

printf '%s' "$ITEM" | jq '{id, source_generation_id, expected_output}'
printf '%s' "$ITEM" | jq -e --arg gen "$GENERATION_ID" '.source_generation_id == $gen'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: dataset } = await adminSoat.evaluations.createDataset({
  body: { project_id: project.id, name: 'support-regressions' },
});

const { data: item } =
  await adminSoat.evaluations.createDatasetItemFromGeneration({
    path: { dataset_id: dataset.id },
    body: {
      generation_id: turn.generation_id,
      expected_output: 'Apologize, confirm the refund, and give the timeline.',
    },
  });

console.log(item.source_generation_id);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DATASET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"support-regressions\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/datasets/$DATASET_ID/items/from-generation" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"generation_id\":\"$GENERATION_ID\",\"expected_output\":\"Apologize, confirm the refund, and give the timeline.\"}" \
  | jq '{id, source_generation_id}'
```

</TabItem>
</Tabs>

The item is a **copy**: `source_generation_id` records provenance, but purging or deleting that generation neither deletes nor rewrites the item, so the regression baseline stays fixed. A fork, next, stays bound to real history instead.

---

## Step 5 — Fork the session and answer it differently

A second agent whose instructions commit to a decision, and the same conversation up to the customer's question.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STRICT_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Drafter (strict)" \
  --instructions "Apologize once, state the refund or replacement decision explicitly, and give a timeline. Two sentences at most." | jq -r '.id')

FORK=$(soat fork-session \
  --session-id "$SESSION_ID" \
  --fork-at-position 2 \
  --agent-id "$STRICT_AGENT_ID" \
  --name "retry: strict drafter" \
  --tags '{"experiment":"strict-v1"}')

FORK_ID=$(printf '%s' "$FORK" | jq -r '.id')
FORK_CONVERSATION_ID=$(printf '%s' "$FORK" | jq -r '.conversation_id')

printf '%s' "$FORK" | jq '{id, agent_id, forked_from_session_id, forked_from_position, auto_generate, tags}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: strictAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: project.id,
    ai_provider_id: provider.id,
    name: 'Support Drafter (strict)',
    instructions:
      'Apologize once, state the refund or replacement decision explicitly, and give a timeline. Two sentences at most.',
  },
});

const { data: fork } = await adminSoat.sessions.forkSession({
  path: { session_id: session.id },
  body: {
    fork_at_position: 2,
    agent_id: strictAgent.id,
    name: 'retry: strict drafter',
    tags: { experiment: 'strict-v1' },
  },
});

console.log(fork.forked_from_session_id, fork.forked_from_position);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/fork" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"fork_at_position\":2,\"agent_id\":\"$STRICT_AGENT_ID\",\"name\":\"retry: strict drafter\"}" \
  | jq '{id, agent_id, forked_from_session_id, forked_from_position, auto_generate}'
```

</TabItem>
</Tabs>

```json
{
  "id": "sess_FjoSC0ZDvvffv6kc",
  "agent_id": "agent_Ft2qBeIoZf7SLftN",
  "forked_from_session_id": "sess_O7PvO1CQ7Lq3h0wW",
  "forked_from_position": 2,
  "auto_generate": false,
  "tags": { "experiment": "strict-v1" }
}
```

`fork_at_position` branches **after** that position: the fork holds messages 0–2, up to the customer's question and without the answer under replacement. Omit it to branch at the tip.

### The fork references the parent's documents

The fork has its own message rows pointing at the **same document rows**; only the ordering was duplicated:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PARENT_DOC=$(soat list-conversation-messages --conversation-id "$CONVERSATION_ID" | jq -r '.data[0].document_id')
FORK_DOCS=$(soat list-conversation-messages --conversation-id "$FORK_CONVERSATION_ID")

printf '%s' "$FORK_DOCS" | jq '.data | map({position, role, document_id})'

# Same document row, not a copy of the text — and only up to the fork point.
printf '%s' "$FORK_DOCS" | jq -e --arg doc "$PARENT_DOC" '.data[0].document_id == $doc'
printf '%s' "$FORK_DOCS" | jq -e '(.data | length) == 3'

# The parent still has all four of its messages.
soat list-conversation-messages --conversation-id "$CONVERSATION_ID" | jq -e '(.data | length) == 4'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: parentMessages } =
  await adminSoat.conversations.listConversationMessages({
    path: { conversation_id: session.conversation_id },
  });
const { data: forkMessages } =
  await adminSoat.conversations.listConversationMessages({
    path: { conversation_id: fork.conversation_id },
  });

console.log(
  forkMessages.data[0].document_id === parentMessages.data[0].document_id
); // true
console.log(forkMessages.data.length, parentMessages.data.length); // 3 4
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/conversations/$FORK_CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({position, document_id})'
```

</TabItem>
</Tabs>

One stored copy: a retention purge erases parent and fork together, storage is proportional to the conversation rather than to the number of experiments, and the fork cannot drift from what happened.

### Drive the branch

The fork is created **inert** (`auto_generate` is `false`, no generation triggered):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat generate-session-response --session-id "$FORK_ID" --wait true \
  | jq '{status, generation_id, content: .message.content}'

soat list-session-forks --session-id "$SESSION_ID" \
  | jq '{total, data: (.data | map({id, name, agent_id, forked_from_position}))}'

soat list-session-forks --session-id "$SESSION_ID" | jq -e --arg fork "$FORK_ID" \
  '[.data[] | select(.id == $fork)] | length == 1'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: retry } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: fork.id },
  query: { wait: true },
});
console.log(retry.message?.content);

const { data: forks } = await adminSoat.sessions.listSessionForks({
  path: { session_id: session.id },
});
console.log(forks.total);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$FORK_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, generation_id}'

curl -s "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/forks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{total, data: (.data | map(.id))}'
```

</TabItem>
</Tabs>

Two agents have answered the same question from the same context; both conversations are intact. `GET /forks` walks **one level**: forking a fork is allowed and unbounded, each branch listed under its own parent.

:::caution Forking replays tool results — it never re-invokes tools
Recorded tool results travel with the copied messages and are replayed as model input, so a fork cannot re-run `send_email` or `charge_card`. The fork sees tool data **as it was**, not as it is now: right for a comparison, wrong for resuming a session for real.
:::

The fork starts with **no actor** ([single session per actor](/docs/modules/sessions#single-session-per-actor) allows one open session per (agent, actor) pair), and `forked_from_session_id` becomes `null` if the parent is deleted; the fork is a real session with its own history.

---

## Step 6 — Prove the fix against the fixture

The captured item is an ordinary dataset item, so the [eval](/docs/modules/evaluations) machinery applies unchanged, with the strict agent under test:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
EVAL_ID=$(soat create-eval \
  --project-id "$PROJECT_ID" \
  --name "refund-clarity" \
  --agent-id "$STRICT_AGENT_ID" \
  --dataset-id "$DATASET_ID" \
  --scorers '[{"type":"json_logic","expression":{"!=":[{"var":"output"},""]}}]' \
  --pass-threshold 0.5 | jq -r '.id')

RUN=$(soat start-eval-run --eval-id "$EVAL_ID" --wait true)
RUN_ID=$(printf '%s' "$RUN" | jq -r '.id')

printf '%s' "$RUN" | jq '{status, passed, completed_count, errored_count, aggregate_scores}'
printf '%s' "$RUN" | jq -e '.status == "completed"'

soat list-eval-results --eval-id "$EVAL_ID" --eval-run-id "$RUN_ID" \
  | jq '.data | map({dataset_item_id, scores})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: evaluation } = await adminSoat.evaluations.createEval({
  body: {
    project_id: project.id,
    name: 'refund-clarity',
    agent_id: strictAgent.id,
    dataset_id: dataset.id,
    scorers: [
      { type: 'json_logic', expression: { '!=': [{ var: 'output' }, ''] } },
    ],
    pass_threshold: 0.5,
  },
});

const { data: run } = await adminSoat.evaluations.startEvalRun({
  path: { eval_id: evaluation.id },
  body: { wait: true },
});

console.log(run.status, run.passed, run.aggregate_scores);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"wait":true}' | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/evals/$EVAL_ID/runs/$RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, passed, aggregate_scores}'
```

</TabItem>
</Tabs>

The run replays the item's recorded input against the named agent, so the agent is the only variable. `json_logic` is the cheap structural scorer; for output with no single correct string, bind `llm_judge` ([Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers)).

---

## What you built

```txt
production turn  ──get-generation-transcript──▶  read it back, step by step
       │
       ├────create-dataset-item-from-generation──▶  frozen fixture  ──▶  eval run
       │                                            (copy: survives a purge)
       └────fork-session --fork-at-position 2────▶  branch  ──▶  new answer
                                                    (reference: dies with its parent's content)
```

The fixture is a **copy**, so production cannot rewrite the dataset; the fork is a **reference**, so the branch cannot drift from the conversation it continues.

## What's next

- [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) — baselines and comparison.
- [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers) — answers with no single correct string.
- [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) — rollouts that wait for evidence.
- [Debug Session, Generation, and Trace History](/docs/tutorials/debug-session-generation-trace-history) — sessions, generations, traces.
- [Data Retention and Zero Retention](/docs/tutorials/data-retention-and-zero-retention) — purges vs transcripts, forks, curated items.
