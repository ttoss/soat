---
sidebar_position: 11
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Deep Thinking: Reasoning Pipelines

This tutorial walks through the reasoning (deep-thinking) pipeline primitive step by step. You will:

1. Log in as admin and create a project, AI provider, and base agent.
2. Build a **reflect** (self-critique) pipeline — a single step that critiques and revises the draft.
3. Build a **debate** pipeline — two branches argue back and forth over multiple rounds, then a synthesis step reconciles them.
4. Build a **best-of-N** (self-consistency) pipeline — independent samples at varying temperature, judged by a final step.
5. See auto-named perspectives as a one-line variant of the same primitive.

By the end you will understand the single primitive — `1..N branches × 1..R rounds` per step — that every reasoning strategy in SOAT reduces to. See [Agents — Reasoning (Deep Thinking)](/docs/modules/agents#reasoning-deep-thinking) for the full field reference and token grammar.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and generations before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available.
- This repo's tutorial test stack already provisions Ollama with `qwen2.5:0.5b`, so this tutorial runs in automated tests without external credentials.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

CLI path flags in this tutorial are resource-specific and kebab-cased, for example `--agent-id`.

</TabItem>
<TabItem value="sdk" label="SDK">

All code snippets below use a `SoatClient` instance. The authenticated instance is created in Step 1 after login.

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

## Step 1 — Log in, create a project, provider, and agent

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for authentication details, [Projects](/docs/modules/projects#examples) for project management, and [AI Providers](/docs/modules/ai-providers#examples) for provider setup. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

PROJECT_ID=$(soat create-project --name "Deep Thinking Tutorial" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Deep Thinker" \
  --instructions "You are a concise assistant. Keep answers short (max 30 words)." \
  | jq -r '.id')

echo "PROJECT_ID: $PROJECT_ID"
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: session } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: session.token,
});

const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Deep Thinking Tutorial' },
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
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Deep Thinker',
    instructions: 'You are a concise assistant. Keep answers short (max 30 words).',
  },
});
const AGENT_ID = agent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Deep Thinking Tutorial"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" \
  | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Deep Thinker\",\"instructions\":\"You are a concise assistant. Keep answers short (max 30 words).\"}" \
  | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 2 — Reflect (self-critique)

The simplest recipe is a single step with **no `branches`** — the degenerate `1 branch × 1 round` case of the primitive. It reads `{draft}` (the agent's own first-pass answer), critiques it, and its output becomes the final answer because it is the only step. `halt_if_equals` lets the model short-circuit and keep the draft when it has nothing to add. See [Agents — Pipeline mode](/docs/modules/agents#pipeline-mode) for the full token grammar.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent \
  --agent-id "$AGENT_ID" \
  --reasoning '{
    "mode": "pipeline",
    "steps": [
      {
        "name": "critique",
        "prompt": "Question: {question}\nDraft answer: {draft}\nIf the draft is already correct and concise, reply exactly APPROVED. Otherwise, reply with an improved answer only.",
        "halt_if_equals": "APPROVED",
        "output": true
      }
    ]
  }'

soat create-agent-generation \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"What is the capital of France?"}]' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.agents.updateAgent({
  path: { agent_id: AGENT_ID },
  body: {
    reasoning: {
      mode: 'pipeline',
      steps: [
        {
          name: 'critique',
          prompt:
            'Question: {question}\nDraft answer: {draft}\nIf the draft is already correct and concise, reply exactly APPROVED. Otherwise, reply with an improved answer only.',
          halt_if_equals: 'APPROVED',
          output: true,
        },
      ],
    },
  },
});

const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  body: {
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  },
});
console.log(generation.status, generation.output.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reasoning": {
      "mode": "pipeline",
      "steps": [
        {
          "name": "critique",
          "prompt": "Question: {question}\nDraft answer: {draft}\nIf the draft is already correct and concise, reply exactly APPROVED. Otherwise, reply with an improved answer only.",
          "halt_if_equals": "APPROVED",
          "output": true
        }
      ]
    }
  }' | jq '.reasoning'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

`halt_if_equals` only applies to a single-branch step — a multi-branch step's output is a concatenation of several turns, so comparing it against one string would not be meaningful. Trying to set it on a step with `branches` is rejected with `INVALID_REASONING_CONFIG`.

---

## Step 3 — Debate (branches + rounds + `{transcript}`)

A debate is `branches` (one per side) run over several `rounds`, where each branch's prompt references `{transcript}` — the token whose presence is what turns on the shared, sequential transcript. Without `{transcript}`, `rounds` would just repeat identical-config, independent samples, which is why the server rejects `rounds > 1` when no prompt references it. A final single-branch step reconciles the debate by reading `{steps.debate}` (the full transcript) or `{steps.debate.last}` (only the final turn). See [Agents — Pipeline mode](/docs/modules/agents#pipeline-mode) for the `{steps.<name>}` / `{steps.<name>.last}` distinction.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent \
  --agent-id "$AGENT_ID" \
  --reasoning '{
    "mode": "pipeline",
    "steps": [
      {
        "name": "debate",
        "rounds": 2,
        "branches": [
          { "name": "Optimist", "prompt": "Question: {question}\nArgue the optimistic case. Prior turns:\n{transcript}" },
          { "name": "Skeptic", "prompt": "Question: {question}\nArgue the skeptical case. Prior turns:\n{transcript}" }
        ]
      },
      {
        "name": "final",
        "prompt": "Question: {question}\nDebate transcript:\n{steps.debate}\nWrite a short, balanced final answer.",
        "output": true
      }
    ]
  }'

soat create-agent-generation \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Should a small team adopt microservices?"}]' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.agents.updateAgent({
  path: { agent_id: AGENT_ID },
  body: {
    reasoning: {
      mode: 'pipeline',
      steps: [
        {
          name: 'debate',
          rounds: 2,
          branches: [
            {
              name: 'Optimist',
              prompt:
                'Question: {question}\nArgue the optimistic case. Prior turns:\n{transcript}',
            },
            {
              name: 'Skeptic',
              prompt:
                'Question: {question}\nArgue the skeptical case. Prior turns:\n{transcript}',
            },
          ],
        },
        {
          name: 'final',
          prompt:
            'Question: {question}\nDebate transcript:\n{steps.debate}\nWrite a short, balanced final answer.',
          output: true,
        },
      ],
    },
  },
});

const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  body: {
    messages: [
      { role: 'user', content: 'Should a small team adopt microservices?' },
    ],
  },
});
console.log(generation.status, generation.output.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reasoning": {
      "mode": "pipeline",
      "steps": [
        {
          "name": "debate",
          "rounds": 2,
          "branches": [
            { "name": "Optimist", "prompt": "Question: {question}\nArgue the optimistic case. Prior turns:\n{transcript}" },
            { "name": "Skeptic", "prompt": "Question: {question}\nArgue the skeptical case. Prior turns:\n{transcript}" }
          ]
        },
        {
          "name": "final",
          "prompt": "Question: {question}\nDebate transcript:\n{steps.debate}\nWrite a short, balanced final answer.",
          "output": true
        }
      ]
    }
  }' | jq '.reasoning'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Should a small team adopt microservices?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

Each branch turn (and the final synthesis) creates a child [generation](/docs/modules/generations) record, so `GET /generations?trace_id=<trace_id>` shows the full debate tree. See [Agents — Observability](/docs/modules/agents#observability).

---

## Step 4 — Best-of-N (self-consistency)

Best-of-N samples the same question **independently** — `branches` whose prompts do **not** reference `{transcript}` — typically varying `temperature` per branch, then a judge step picks or synthesizes from `{steps.samples}` (the full set of samples). Never read `{steps.samples.last}` here: on an independent multi-branch step the last turn is an arbitrary sample, not a converged result, so the server rejects that reference at write time.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent \
  --agent-id "$AGENT_ID" \
  --reasoning '{
    "mode": "pipeline",
    "steps": [
      {
        "name": "samples",
        "prompt": "Question: {question}\nAnswer concisely.",
        "branches": [
          { "name": "A", "temperature": 0.2 },
          { "name": "B", "temperature": 0.7 },
          { "name": "C", "temperature": 1.0 }
        ]
      },
      {
        "name": "final",
        "prompt": "Question: {question}\nCandidate answers:\n{steps.samples}\nPick or synthesize the single best answer.",
        "output": true
      }
    ]
  }'

soat create-agent-generation \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Name one benefit of code review."}]' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.agents.updateAgent({
  path: { agent_id: AGENT_ID },
  body: {
    reasoning: {
      mode: 'pipeline',
      steps: [
        {
          name: 'samples',
          prompt: 'Question: {question}\nAnswer concisely.',
          branches: [
            { name: 'A', temperature: 0.2 },
            { name: 'B', temperature: 0.7 },
            { name: 'C', temperature: 1.0 },
          ],
        },
        {
          name: 'final',
          prompt:
            'Question: {question}\nCandidate answers:\n{steps.samples}\nPick or synthesize the single best answer.',
          output: true,
        },
      ],
    },
  },
});

const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  body: {
    messages: [{ role: 'user', content: 'Name one benefit of code review.' }],
  },
});
console.log(generation.status, generation.output.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reasoning": {
      "mode": "pipeline",
      "steps": [
        {
          "name": "samples",
          "prompt": "Question: {question}\nAnswer concisely.",
          "branches": [
            { "name": "A", "temperature": 0.2 },
            { "name": "B", "temperature": 0.7 },
            { "name": "C", "temperature": 1.0 }
          ]
        },
        {
          "name": "final",
          "prompt": "Question: {question}\nCandidate answers:\n{steps.samples}\nPick or synthesize the single best answer.",
          "output": true
        }
      ]
    }
  }' | jq '.reasoning'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Name one benefit of code review."}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

This is sampling plus an author-written judge step — SOAT does not ship a turnkey `vote`/`pick` reducer. Reduction stays intentionally minimal (concat, or `.last` on a converged step); anything richer belongs in the [orchestration engine](/docs/modules/orchestrations), not the reasoning pipeline.

---

## Step 5 — Auto-named perspectives

The former `count: N` shorthand (auto-generated, unnamed perspectives) is now just a `branches` list — one line longer, but fully explicit and inspectable:

```json
{
  "name": "angles",
  "prompt": "Question: {question}\nGive one distinct angle on this.",
  "branches": [{}, {}, {}]
}
```

Three implicit, unnamed branches share the step's `prompt` (no `{transcript}` reference, so they run as independent samples, like Step 4). See [Agents — Reasoning (Deep Thinking)](/docs/modules/agents#reasoning-deep-thinking) for every field and cap (`branches`: 1–5 per step, `rounds`: 1–3, `steps`: up to 8, 24 total completions per pipeline).

---

## What you learned

| Concept                     | Takeaway                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Single primitive**          | Every step is `1..N branches × 1..R rounds`. `kind`, `count`, and `perspectives` do not exist — only `branches`. |
| **`{transcript}`**            | Its presence in a prompt is what turns on the shared, sequential transcript (debate). Its absence means independent, parallel-eligible samples (best-of-N). |
| **`{steps.<name>}` vs `.last`** | `{steps.x}` is the full concatenated transcript; `{steps.x.last}` is only the final turn — valid only on a single-branch or `{transcript}`-shared step. |
| **`rounds` needs `{transcript}`** | `rounds > 1` with no `{transcript}` reference is rejected — it would just be redundant, identical-config sampling. |
| **`halt_if_equals`**           | Single-branch steps only; rejected on any step with `branches`.                                               |
| **Judge steps, not reducers**  | Selecting among samples is an author-written step over `{steps.x}` — SOAT has no built-in `vote`/`pick`.       |

## Next steps

- See [Agents — Reasoning (Deep Thinking)](/docs/modules/agents#reasoning-deep-thinking) for the full field reference, caps, and observability model.
- See [Orchestrations](/docs/modules/orchestrations) when you need tool-using, permissioned agents composed into a persisted, resumable graph — reasoning pipelines are pure, ephemeral meta-cognition over a single answer.
- See [Webhooks](/docs/modules/webhooks#examples) to subscribe to `agents.reasoning.fallback` and detect when a pipeline silently degraded to the plain draft.
