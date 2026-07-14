---
sidebar_position: 15
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Review Panel: Check a Draft's Fundamentals and Tone

This tutorial builds a real editorial workflow: a **writer agent** produces a draft, then hands it to a **review panel** — two reviewers that check the *fundamentals* (factual accuracy and logical structure) and one reviewer that checks the *voice and tone*. A final **synthesis** pass weighs all three reviews into a single, actionable verdict the writer can act on.

The panel is a [Discussion](/docs/modules/discussions) — a reusable deliberation config whose participants are tool-less "voices". The writer invokes it mid-loop through a [`discussion`-type tool](/docs/modules/tools#discussion), passing its own draft as the topic. This is how deep thinking works in SOAT after it moved off the agent's old `reasoning` config — see [Migrating from agent reasoning](/docs/modules/discussions#migrating-from-agent-reasoning).

You will:

1. Log in as admin.
2. Create a project and an Ollama AI provider.
3. Create a **review-panel discussion** with three participants and a synthesis pass:
   - `Fact Checker` — verifies claims are accurate and supported.
   - `Logic Reviewer` — checks the argument is well-structured and free of gaps.
   - `Voice & Tone Reviewer` — checks the writing matches the intended voice.
4. Run the panel directly on a sample draft to see the synthesized verdict.
5. Wrap the panel in a `discussion`-type tool.
6. Create a writer agent that drafts text and then calls the panel to review it.
7. Run a generation and observe the writer consulting the panel.

By the end you will understand:

- How to model a multi-reviewer review as participants plus a synthesis pass.
- Why a single reviewer for `fundamentals` and a separate one for `tone` beats one do-everything prompt.
- How an agent invokes a discussion as a tool and consumes only the synthesized outcome.

## Prerequisites

- SOAT running locally with Ollama. Follow the [Quick Start](/docs/getting-started) guide, and skim [Key Concepts](/docs/getting-started/concepts) if SOAT's mental model is new to you. For production hardening (secrets, env vars), see [Configuration](/docs/getting-started/advanced-config).
- An [Ollama](https://ollama.com) instance accessible at `http://ollama:11434` with model `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl available. The server is at `http://localhost:5047`.

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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [IAM — Authentication](/docs/modules/iam#authentication) for details on JWT tokens and the admin role.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password Admin1234!
soat configure   # paste the token when prompted
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
  token: session!.token,
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

## Step 2 — Create a project

Every resource in SOAT lives inside a [project](/docs/modules/projects#examples). Create one to hold the provider, the discussion, the tool, and the agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Editorial Review" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Editorial Review' },
});
const projectId = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Editorial Review"}' | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an Ollama AI provider

Set up a local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama. Both the writer agent and every panel participant fall back to this provider. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "Provider: $PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: projectId,
    name: 'Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});
const providerId = provider!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')
echo "Provider: $PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create the review-panel discussion

Create a [discussion](/docs/modules/discussions#examples) with three participants. Two of them cover the **fundamentals** — one checks factual accuracy, one checks logical structure — and the third checks **voice and tone**. Splitting fundamentals across two focused reviewers (rather than one "check everything" reviewer) keeps each turn narrow and its verdict crisp; see [Deliberation and synthesis](/docs/modules/discussions#deliberation-and-synthesis) for how the turns run.

The `synthesis` object overrides the final pass that merges the three reviews. Its prompt uses the `{topic}` placeholder (the draft under review) and `{steps.deliberation}` (the transcript of all reviewer turns) — see [Synthesis](/docs/modules/discussions#synthesis).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DISCUSSION_ID=$(soat create-discussion \
  --project-id "$PROJECT_ID" \
  --name "Draft review panel" \
  --description "Checks a draft for fundamentals (accuracy + logic) and voice/tone." \
  --ai-provider-id "$PROVIDER_ID" \
  --max-rounds 1 \
  --participants '[
    {
      "name": "Fact Checker",
      "prompt": "You verify fundamentals. List every factual claim in the draft and mark each Supported, Unsupported, or Wrong. Do not comment on style."
    },
    {
      "name": "Logic Reviewer",
      "prompt": "You review structure and reasoning. Point out gaps, non-sequiturs, and unstated assumptions. Do not comment on factual accuracy or style."
    },
    {
      "name": "Voice & Tone Reviewer",
      "prompt": "You review only voice and tone. The target voice is clear, confident, and concise. Flag hedging, jargon, and shifts in register. Do not comment on facts or logic."
    }
  ]' \
  --synthesis '{
    "prompt": "You are the editor. The draft under review is:\n\n{topic}\n\nThe panel gave these reviews:\n\n{steps.deliberation}\n\nProduce a single verdict: SHIP or REVISE, followed by the top 3 concrete fixes ordered by importance."
  }' | jq -r '.id')
echo "Discussion: $DISCUSSION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: discussion } = await adminSoat.discussions.createDiscussion({
  body: {
    project_id: projectId,
    name: 'Draft review panel',
    description:
      'Checks a draft for fundamentals (accuracy + logic) and voice/tone.',
    ai_provider_id: providerId,
    max_rounds: 1,
    participants: [
      {
        name: 'Fact Checker',
        prompt:
          'You verify fundamentals. List every factual claim in the draft and mark each Supported, Unsupported, or Wrong. Do not comment on style.',
      },
      {
        name: 'Logic Reviewer',
        prompt:
          'You review structure and reasoning. Point out gaps, non-sequiturs, and unstated assumptions. Do not comment on factual accuracy or style.',
      },
      {
        name: 'Voice & Tone Reviewer',
        prompt:
          'You review only voice and tone. The target voice is clear, confident, and concise. Flag hedging, jargon, and shifts in register. Do not comment on facts or logic.',
      },
    ],
    synthesis: {
      prompt:
        'You are the editor. The draft under review is:\n\n{topic}\n\nThe panel gave these reviews:\n\n{steps.deliberation}\n\nProduce a single verdict: SHIP or REVISE, followed by the top 3 concrete fixes ordered by importance.',
    },
  },
});
const discussionId = discussion!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DISCUSSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/discussions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "Draft review panel",
    "description": "Checks a draft for fundamentals (accuracy + logic) and voice/tone.",
    "ai_provider_id": "'"$PROVIDER_ID"'",
    "max_rounds": 1,
    "participants": [
      { "name": "Fact Checker", "prompt": "You verify fundamentals. List every factual claim in the draft and mark each Supported, Unsupported, or Wrong. Do not comment on style." },
      { "name": "Logic Reviewer", "prompt": "You review structure and reasoning. Point out gaps, non-sequiturs, and unstated assumptions. Do not comment on factual accuracy or style." },
      { "name": "Voice & Tone Reviewer", "prompt": "You review only voice and tone. The target voice is clear, confident, and concise. Flag hedging, jargon, and shifts in register. Do not comment on facts or logic." }
    ],
    "synthesis": {
      "prompt": "You are the editor. The draft under review is:\n\n{topic}\n\nThe panel gave these reviews:\n\n{steps.deliberation}\n\nProduce a single verdict: SHIP or REVISE, followed by the top 3 concrete fixes ordered by importance."
    }
  }' | jq -r '.id')
echo "Discussion: $DISCUSSION_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Run the panel directly on a sample draft

Before wiring it to an agent, invoke the panel yourself to see the synthesized verdict. The `topic` is the draft under review. The run is LLM-dependent, so its `outcome` will vary — inspect the [run](/docs/modules/discussions#discussionrun) but do not depend on exact wording.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# The outcome is free-form model text; print the raw run rather than piping it
# through jq (LLM text can contain bytes that break a full JSON parse).
soat create-discussion-run \
  --discussion-id "$DISCUSSION_ID" \
  --topic "The moon is the largest object in the solar system, so obviously we should build our data center there to cut latency for everyone on Earth."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await adminSoat.discussions.createDiscussionRun({
  path: { discussion_id: discussionId },
  body: {
    topic:
      'The moon is the largest object in the solar system, so obviously we should build our data center there to cut latency for everyone on Earth.',
  },
});

console.log('Status:', run!.status);
console.log('Verdict:', run!.outcome);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/discussions/$DISCUSSION_ID/runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "topic": "The moon is the largest object in the solar system, so obviously we should build our data center there to cut latency for everyone on Earth." }' \
  | jq '{ id, status }'
```

</TabItem>
</Tabs>

The `Fact Checker` should flag the false claim, the `Logic Reviewer` the non-sequitur, and the `Voice & Tone Reviewer` the "obviously". The synthesis merges those into one `REVISE` verdict. The full transcript persists as a [Conversation](/docs/modules/conversations) and the verdict as a [Document](/docs/modules/documents) on the run.

---

## Step 6 — Wrap the panel in a tool

To let an agent consult the panel mid-loop, expose it as a [`discussion`-type tool](/docs/modules/tools#discussion). The tool references the discussion by ID; calling it with a `topic` runs the discussion synchronously and returns `{ outcome, run_id }` — only the synthesized verdict, never the full transcript.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
REVIEW_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "review-panel" \
  --type discussion \
  --description "Sends a draft to the editorial review panel and returns a SHIP/REVISE verdict with concrete fixes." \
  --discussion '{"discussion_id": "'"$DISCUSSION_ID"'"}' | jq -r '.id')
echo "Tool: $REVIEW_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reviewTool } = await adminSoat.tools.createTool({
  body: {
    project_id: projectId,
    name: 'review-panel',
    type: 'discussion',
    description:
      'Sends a draft to the editorial review panel and returns a SHIP/REVISE verdict with concrete fixes.',
    discussion: { discussion_id: discussionId },
  },
});
const reviewToolId = reviewTool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
REVIEW_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "review-panel",
    "type": "discussion",
    "description": "Sends a draft to the editorial review panel and returns a SHIP/REVISE verdict with concrete fixes.",
    "discussion": { "discussion_id": "'"$DISCUSSION_ID"'" }
  }' | jq -r '.id')
echo "Tool: $REVIEW_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Create the writer agent

Create the [writer agent](/docs/modules/agents#examples) and attach the review tool. Its instructions tell it to draft, then consult the panel, then revise if the verdict is `REVISE`. Because the tool result carries only the synthesized `outcome`, the writer's context stays small no matter how much the panel deliberated.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name "Writer" \
  --instructions "You write short marketing blurbs. After drafting, call the review-panel tool with your draft as the topic. If the verdict is REVISE, apply the top fixes and return the improved blurb. If SHIP, return the draft as-is." \
  --tool-ids '["'"$REVIEW_TOOL_ID"'"]' | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: projectId,
    ai_provider_id: providerId,
    name: 'Writer',
    instructions:
      'You write short marketing blurbs. After drafting, call the review-panel tool with your draft as the topic. If the verdict is REVISE, apply the top fixes and return the improved blurb. If SHIP, return the draft as-is.',
    tool_ids: [reviewToolId],
  },
});
const agentId = agent!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "ai_provider_id": "'"$PROVIDER_ID"'",
    "name": "Writer",
    "instructions": "You write short marketing blurbs. After drafting, call the review-panel tool with your draft as the topic. If the verdict is REVISE, apply the top fixes and return the improved blurb. If SHIP, return the draft as-is.",
    "tool_ids": ["'"$REVIEW_TOOL_ID"'"]
  }' | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

To *force* the writer to consult the panel before answering (rather than leaving it to the model), attach a [step rule](/docs/modules/agents#step-rules) or set `tool_choice: required` for the first step.

---

## Step 8 — Run a generation

Ask the writer for a blurb. It drafts, calls `review-panel` with the draft, receives the verdict, and revises. The result is LLM-dependent — check `status` and inspect the output, but do not assert exact wording. Follow the [trace](/docs/modules/traces) to see the discussion run nested inside the generation.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# The result embeds the writer's draft and the panel's free-form verdict, so
# print the raw generation rather than piping it through jq.
soat create-agent-generation \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Write a one-sentence blurb for a note-taking app called Jotly."}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: agentId },
  body: {
    messages: [
      {
        role: 'user',
        content:
          'Write a one-sentence blurb for a note-taking app called Jotly.',
      },
    ],
  },
});

console.log('Status:', generation!.status);
console.log('Result:', generation!.result);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "Write a one-sentence blurb for a note-taking app called Jotly." }
    ]
  }' | jq '{ status }'
```

</TabItem>
</Tabs>

---

## What happened

1. **One discussion, three focused voices.** The panel is a single [Discussion](/docs/modules/discussions) with three participants. Each has a narrow persona — accuracy, logic, tone — so no single turn tries to do everything, and each verdict stays sharp.

2. **Synthesis merges the reviews.** After the reviewers speak, the `synthesis` pass reads the whole transcript (`{steps.deliberation}`) plus the original draft (`{topic}`) and emits one `SHIP`/`REVISE` verdict with ranked fixes. This is the only text the caller sees.

3. **The agent consulted the panel as a tool.** The writer attached a [`discussion`-type tool](/docs/modules/tools#discussion). When it called the tool with its draft, the server ran the discussion synchronously and returned `{ outcome, run_id }`. The full transcript persisted on the run — the writer's context received only the synthesized verdict.

4. **Deep thinking never breaks the flow.** If a reviewer turn or the synthesis fails, the run degrades gracefully rather than erroring — see [Deliberation and synthesis](/docs/modules/discussions#deliberation-and-synthesis).

---

## Next steps

- Add `max_rounds: 2` so reviewers can rebut each other before synthesis — useful when fundamentals and tone pull in opposite directions.
- Give the `Voice & Tone Reviewer` its own `ai_provider_id` or `model` [override](/docs/modules/discussions#participant) to grade tone with a stronger model than the fact check needs.
- Force the review with a [step rule](/docs/modules/agents#step-rules) so the writer can never skip the panel.
- Read the [Discussions module reference](/docs/modules/discussions) for the full participant and synthesis options, and [Migrating from agent reasoning](/docs/modules/discussions#migrating-from-agent-reasoning) if you used the old `reasoning` config.
