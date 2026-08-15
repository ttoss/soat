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

An agent gave a bad answer at message 3 of a real conversation. You want to try a stricter prompt against **that exact context** — not a paraphrase of it typed from memory — and you want the bad answer to become a test case so it cannot come back quietly.

Three operations do that, and they compose into one loop:

| Operation                             | What it gives you                                                |
| ------------------------------------- | ---------------------------------------------------------------- |
| `get-generation-transcript`           | the turn read back step by step — what was asked, what it did    |
| `create-dataset-item-from-generation` | that turn frozen as an [eval](/docs/modules/evaluations) fixture |
| `fork-session`                        | a new session branched at any message, same context              |

You will produce a turn that goes wrong, read it back, capture it, branch the session at the customer's question, answer it with a different agent, and score the result against the captured fixture.

This tutorial assumes you have been through [Evaluate an Agent](/docs/tutorials/evaluate-an-agent).

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` available. This tutorial uses a local provider so it runs without external credentials — to connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and sessions first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Server is at `http://localhost:5047`.

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

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for authentication details.

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

A support drafter with vague instructions, and a customer whose second message asks the question that matters. See [Sessions](/docs/modules/sessions) for the session lifecycle.

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

The conversation is four messages, each backed by a [Document](/docs/modules/documents) — note the `document_id` values, they are the thing the fork will share:

```json
[
  { "position": 0, "role": "user", "document_id": "doc_xhKfqZS0h81cSgaW" },
  { "position": 1, "role": "assistant", "document_id": "doc_opF0s5dnVb0iISJT" },
  { "position": 2, "role": "user", "document_id": "doc_YySNY6X8dUvUaoP0" },
  { "position": 3, "role": "assistant", "document_id": "doc_hKyysHRAWkdkmcyq" }
]
```

Position 3 is the answer that ducked the refund question. Everything below works from it.

---

## Step 3 — Read the turn back

A [transcript](/docs/modules/generations) is the turn reconstructed at read time: the messages it was asked, each model step in order with its tool calls and results, and the final answer. It is assembled from the generation record and the trace's steps object — never stored, so it **dies with the content it projects** rather than outliving a [retention](/docs/modules/traces#retention-policy) purge.

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

`agent_version` is the config that actually served the turn, `step_count` survives a purge even when `steps` is empty, and `status` disambiguates an empty transcript caused by a run still in flight from one caused by erased content. A turn that called tools shows them per step, which is how you see _why_ an answer came out the way it did instead of guessing from the final text.

---

## Step 4 — Freeze the turn as a fixture

Hand-authored dataset items drift away from what production traffic looks like. Curating from a real generation copies the turn's input — and its output as `expected_output` when you do not supply one — into a [dataset item](/docs/modules/evaluations#dataset) that records where it came from.

Here the recorded answer is the bad one, so pass the answer you _wanted_:

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

The item is a **copy**, deliberately. `source_generation_id` records the provenance, but purging or deleting that generation neither deletes nor rewrites the item — a fixture that mutated under you would silently rewrite the baseline every regression report is compared against.

That is the opposite of what forking does next, and the difference is the whole design: **a fixture must be frozen, a fork must stay bound to real history.**

---

## Step 5 — Fork the session and answer it differently

Now the experiment. A second agent with instructions that actually commit to a decision, and the same conversation up to the customer's question.

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

`fork_at_position` branches **after** that position, so the fork holds messages 0–2 — up to and including the customer's question, and not the answer you are trying to replace. Omit it to branch at the tip.

### The fork references the parent's documents

The fork's conversation has its own message rows, but they point at the **same document rows**. Only the ordering was duplicated:

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

This is what keeps the branch honest. One stored copy of the content means a retention purge erases it from parent and fork together, storage stays proportional to the conversation rather than to the number of experiments, and the fork cannot drift from what actually happened.

### Drive the branch

The fork is created **inert** — `auto_generate` is `false` and no generation was triggered. Creating a branch and running it are separate acts:

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

Two agents have now answered the same question from the same context, and both conversations are intact and addressable. `GET /forks` walks **one level**: forking a fork is allowed and unbounded, and each branch is listed under its own parent.

:::caution Forking replays tool results — it never re-invokes tools
A forked turn re-encounters tool calls that already ran. Some are idempotent reads; `send_email` and `charge_card` are not. So the recorded results travel with the copied messages and are replayed as model input — exploring a "what if" cannot charge a card a second time.

The honest consequence: the fork sees the tool data **as it was**, not as it is now. That is what you want for a comparison (change one variable, not two) and wrong for "resume this session for real," which is not what forking is.
:::

Two more things the fork deliberately does not inherit: it starts with **no actor**, because [single session per actor](/docs/modules/sessions#single-session-per-actor) allows one open session per (agent, actor) pair and inheriting would make forking impossible for exactly the agents that enforce it; and `forked_from_session_id` becomes `null` if you delete the parent, because a fork is a real session with its own history and must not vanish with it.

---

## Step 6 — Prove the fix against the fixture

The captured item is now an ordinary dataset item, so the [eval](/docs/modules/evaluations) machinery applies unchanged — this time with the strict agent under test:

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

The run replays the item's recorded input — the exact message list that turn was asked — against the agent you name, so the only thing that changed between the production failure and this run is the agent. A `json_logic` scorer is the cheap structural floor used here; for output with no single correct string, bind an `llm_judge` scorer instead ([Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers)).

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

The two halves pull in opposite directions on purpose. The fixture is a **copy** because a dataset must not be rewritten by what happens to production afterwards. The fork is a **reference** because a branch that drifted from the conversation it claims to continue would be an experiment about nothing.

## What's next

- [Evaluate an Agent](/docs/tutorials/evaluate-an-agent) — baselines, comparison over the item intersection, and what the numbers mean.
- [Judge Open-Ended Answers](/docs/tutorials/judge-open-ended-answers) — score answers that have no single correct string.
- [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval) — make a rollout wait for the evidence you just captured.
- [Debug Session, Generation, and Trace History](/docs/tutorials/debug-session-generation-trace-history) — the wider mapping between sessions, generations, and traces.
- [Data Retention and Zero Retention](/docs/tutorials/data-retention-and-zero-retention) — what a purge does to transcripts, forks, and curated items.
