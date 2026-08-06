---
description: "Treat an agent's prompt like deployable code: archive every config change as a version, roll a new prompt out to a slice of traffic, attribute behavior to a version, and promote or roll back in one call."
keywords:
  - prompt versioning
  - canary deploy AI agent
  - agent rollback
  - staged rollout LLM
  - prompt deployment
  - A/B test agent prompt
sidebar_position: 23
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent Versioning and Canary Rollout

An agent's `instructions` are production code — they decide what every user gets told — but in most stacks they are edited in place. A bad prompt reaches 100% of traffic the moment the save button returns, and the only rollback is retyping the old wording from memory.

SOAT versions the config instead. Every write that changes an [agent](/docs/modules/agents) archives an immutable snapshot, and a **release** can serve two archived versions side by side so a change is tried on a slice of traffic before it reaches everyone. Assignment is deterministic per end user, so nobody flip-flops between two personas mid-conversation.

You will:

1. Create an agent and see version `1` archived on create.
2. Edit it, tag the change with a label, and read the archived config back.
3. Confirm that a write which changes nothing creates no version.
4. Start a **canary release**: 50% of traffic on the new config, 50% on the old.
5. Prove assignment is **sticky per end user** and read which version served each generation.
6. Keep editing during the rollout — live edits are drafts, the split is untouched.
7. **Promote** the canary, then handle the `409` when there is no release to end.
8. **Restore** an old version as a new one, so history stays append-only.

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

## Step 2 — Create an agent (version 1)

Version 1 is archived **on create**, so an agent has recoverable history from the moment it exists rather than from its first edit. See [Projects](/docs/modules/projects) and [AI Providers](/docs/modules/ai-providers) for the resources it depends on.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Rollout Demo" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Bot" \
  --instructions "You are a formal support assistant. Answer in one short sentence." | jq -r '.id')

soat get-agent --agent-id "$AGENT_ID" | jq '{id, version, active_release}'
soat list-agent-versions --agent-id "$AGENT_ID" | jq '.data | map({version, label})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Rollout Demo' },
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
    name: 'Support Bot',
    instructions:
      'You are a formal support assistant. Answer in one short sentence.',
  },
});

console.log(agent.version); // 1

const { data: versions } = await adminSoat.agentVersions.listAgentVersions({
  path: { agent_id: agent.id },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Rollout Demo"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Bot\",\"instructions\":\"You are a formal support assistant. Answer in one short sentence.\"}" | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, version, active_release}'

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/versions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({version, label})'
```

</TabItem>
</Tabs>

Expected output:

```json
{ "id": "agent_POESmEnF6bs58oSy", "version": 1, "active_release": null }
```

---

## Step 3 — Edit the prompt and label the change

`version_label` tags the version the write archives. It annotates the version only — it is not stored on the agent and is not part of the config, so labelling a change is never itself a change. See [Agents — Versioning and Staged Rollout](/docs/modules/agents#versioning-and-staged-rollout).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent --agent-id "$AGENT_ID" \
  --instructions "You are a warm, friendly support assistant. Answer in one short sentence, and open with a greeting." \
  --version-label "friendly-tone" \
  | jq '{version}'

soat list-agent-versions --agent-id "$AGENT_ID" | jq '.data | map({version, label})'
soat get-agent-version --agent-id "$AGENT_ID" --version 1 | jq '{version, config: {instructions: .config.instructions}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: v2 } = await adminSoat.agents.updateAgent({
  path: { agent_id: agent.id },
  body: {
    instructions:
      'You are a warm, friendly support assistant. Answer in one short sentence, and open with a greeting.',
    version_label: 'friendly-tone',
  },
});
console.log(v2.version); // 2

const { data: archived } = await adminSoat.agentVersions.getAgentVersion({
  path: { agent_id: agent.id, version: 1 },
});
console.log(archived.config.instructions); // the original formal prompt
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"instructions":"You are a warm, friendly support assistant. Answer in one short sentence, and open with a greeting.","version_label":"friendly-tone"}' \
  | jq '{version}'

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/versions/1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{version, label}'
```

</TabItem>
</Tabs>

Snapshots are written by the shared business-logic layer, not by the REST handlers, so a `PUT`, a `PATCH`, and a [formation](/docs/modules/formations) apply all leave identical history.

---

## Step 4 — A write that changes nothing creates no version

The comparison runs on the serialized config, not on which fields the request named. Send the instructions the agent already holds and the counter stays where it is.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent --agent-id "$AGENT_ID" \
  --instructions "You are a warm, friendly support assistant. Answer in one short sentence, and open with a greeting." \
  | jq '{version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: unchanged } = await adminSoat.agents.updateAgent({
  path: { agent_id: agent.id },
  body: {
    instructions:
      'You are a warm, friendly support assistant. Answer in one short sentence, and open with a greeting.',
  },
});
console.log(unchanged.version); // still 2
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"instructions":"You are a warm, friendly support assistant. Answer in one short sentence, and open with a greeting."}' \
  | jq '{version}'
```

</TabItem>
</Tabs>

Expected output — still `2`:

```json
{ "version": 2 }
```

This is what makes `restore` safe to call repeatedly: restoring the config an agent already holds is a genuine no-op rather than an endless version chain.

---

## Step 5 — Start a canary release

Serve version 1 as the baseline and version 2 to half of the traffic. See [Agents — Staged Rollout](/docs/modules/agents#staged-rollout).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat set-agent-release --agent-id "$AGENT_ID" \
  --stable-version 1 --canary-version 2 --canary-percent 50 \
  | jq '{version, active_release}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: released } = await adminSoat.agentVersions.setAgentRelease({
  path: { agent_id: agent.id },
  body: { stable_version: 1, canary_version: 2, canary_percent: 50 },
});
console.log(released.active_release);
// { stable_version: 1, canary_version: 2, canary_percent: 50 }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"stable_version":1,"canary_version":2,"canary_percent":50}' \
  | jq '{version, active_release}'
```

</TabItem>
</Tabs>

Expected output:

```json
{
  "version": 2,
  "active_release": {
    "stable_version": 1,
    "canary_version": 2,
    "canary_percent": 50
  }
}
```

---

## Step 6 — Run traffic and read which version served it

Assignment hashes the [actor](/docs/modules/actors) behind the request's [session](/docs/modules/sessions), falling back to the session itself. Create two end users and run a turn for each.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADA_ID=$(soat create-actor --project-id "$PROJECT_ID" \
  --name "Ada" --external-id "+15551230001" | jq -r '.id')
BLAKE_ID=$(soat create-actor --project-id "$PROJECT_ID" \
  --name "Blake" --external-id "+15551230002" | jq -r '.id')

ADA_SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" \
  --actor-id "$ADA_ID" --name "Ada session" --auto-generate false | jq -r '.id')
BLAKE_SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" \
  --actor-id "$BLAKE_ID" --name "Blake session" --auto-generate false | jq -r '.id')

soat add-session-message --session-id "$ADA_SESSION_ID" \
  --message "What are your support hours?" > /dev/null
ADA_GEN_ID=$(soat generate-session-response --session-id "$ADA_SESSION_ID" | jq -r '.generation_id')

soat add-session-message --session-id "$BLAKE_SESSION_ID" \
  --message "What are your support hours?" > /dev/null
BLAKE_GEN_ID=$(soat generate-session-response --session-id "$BLAKE_SESSION_ID" | jq -r '.generation_id')

soat get-generation --generation-id "$ADA_GEN_ID" | jq '{actor: "Ada", agent_version}'
soat get-generation --generation-id "$BLAKE_GEN_ID" | jq '{actor: "Blake", agent_version}'
```

Assignment is **sticky**: run a second turn for the same actor and it lands on the same version.

```bash
soat add-session-message --session-id "$ADA_SESSION_ID" \
  --message "And on weekends?" > /dev/null
ADA_GEN_2_ID=$(soat generate-session-response --session-id "$ADA_SESSION_ID" | jq -r '.generation_id')

soat get-generation --generation-id "$ADA_GEN_2_ID" | jq '{actor: "Ada", turn: 2, agent_version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: ada } = await adminSoat.actors.createActor({
  body: { project_id: project.id, name: 'Ada', external_id: '+15551230001' },
});

const { data: adaSession } = await adminSoat.sessions.createSession({
  body: {
    agent_id: agent.id,
    actor_id: ada.id,
    name: 'Ada session',
    auto_generate: false,
  },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: adaSession.id },
  body: { message: 'What are your support hours?' },
});

const { data: adaTurn } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: adaSession.id },
  body: {},
});

const { data: adaGeneration } = await adminSoat.generations.getGeneration({
  path: { generation_id: adaTurn.generation_id },
});
console.log(adaGeneration.agent_version); // 1 or 2 — and stable for Ada
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/actors" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ada\",\"external_id\":\"+15551230001\"}" | jq -r '.id')

ADA_SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"actor_id\":\"$ADA_ID\",\"name\":\"Ada session\",\"auto_generate\":false}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"What are your support hours?"}' > /dev/null

ADA_GEN_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{}' \
  | jq -r '.generation_id')

curl -s "$SOAT_BASE_URL/api/v1/generations/$ADA_GEN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{agent_version}'
```

</TabItem>
</Tabs>

`agent_version` is a server-owned field on the [generation](/docs/modules/generations) record, not a `metadata` key a caller could set — so "which config produced this answer?" is answerable after the fact, from the [trace](/docs/modules/traces) or from a usage export.

:::note
Requests with neither an actor nor a session — anonymous one-shot generations — are split randomly. Two agent fields are always read from the **live** agent even during a rollout, because they are consumed outside the generation path: `single_session_per_actor` (evaluated when a session is created) and `max_context_messages` (applied before dispatch). Neither changes what the model is told to be.
:::

---

## Step 7 — Keep editing while the canary runs

While a release is active the agent's live columns act as a **draft**. Edits archive new versions without disturbing either side of the running split, so you can keep iterating while a canary is being observed.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent --agent-id "$AGENT_ID" \
  --instructions "You are a warm support assistant. Answer in one short sentence and always offer a follow-up." \
  --version-label "draft-followup" \
  | jq '{version, active_release}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: draft } = await adminSoat.agents.updateAgent({
  path: { agent_id: agent.id },
  body: {
    instructions:
      'You are a warm support assistant. Answer in one short sentence and always offer a follow-up.',
    version_label: 'draft-followup',
  },
});
console.log(draft.version); // 3
console.log(draft.active_release); // unchanged: 1 vs 2 at 50%
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"instructions":"You are a warm support assistant. Answer in one short sentence and always offer a follow-up.","version_label":"draft-followup"}' \
  | jq '{version, active_release}'
```

</TabItem>
</Tabs>

Version 3 exists in history, but no traffic serves it: the split still runs 1 against 2.

---

## Step 8 — Promote the canary (or abort it)

Ending a rollout is one call. `promote` makes the canary's config live; `abort` puts the stable config back.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat promote-agent-release --agent-id "$AGENT_ID" \
  | jq '{version, active_release, instructions}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: promoted } = await adminSoat.agentVersions.promoteAgentRelease({
  path: { agent_id: agent.id },
});
console.log(promoted.active_release); // null
console.log(promoted.instructions); // version 2's prompt, not the version 3 draft
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release/promote" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{version, active_release, instructions}'
```

</TabItem>
</Tabs>

Both `promote` and `abort` **write the winning version's config** before clearing the pointer, rather than just clearing it. Clearing alone would serve whatever draft the live row happened to hold — which, during an abort, is the very config being rolled back. The version 3 draft from Step 7 stays in history as an unreleased version; it is neither promoted by accident nor left serving traffic.

Ending a rollout that is not running is a conflict, not a silent no-op:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat abort-agent-release --agent-id "$AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await adminSoat.agentVersions.abortAgentRelease({
  path: { agent_id: agent.id },
});
console.log(error.code); // NO_ACTIVE_RELEASE (409)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/release/abort" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{code}'   # NO_ACTIVE_RELEASE
```

</TabItem>
</Tabs>

---

## Step 9 — Roll back by restoring a version

`restore-agent-version` copies an archived config onto the agent as a **new** version rather than rewinding the counter. History stays append-only, the versions in between remain retrievable, and "undo the undo" is just another restore.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat restore-agent-version --agent-id "$AGENT_ID" --version 1 \
  | jq '{version, instructions}'

soat list-agent-versions --agent-id "$AGENT_ID" | jq '.data | map({version, label})'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: restored } = await adminSoat.agentVersions.restoreAgentVersion({
  path: { agent_id: agent.id, version: 1 },
});
console.log(restored.instructions); // the original formal prompt, at a new version
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/versions/1/restore" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{version, instructions}'

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/versions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({version, label})'
```

</TabItem>
</Tabs>

Two properties make restore safe to reach for under pressure:

- **The restored config fully replaces the current one.** A field the archived version did not set is cleared, not merged — so a restore cannot leave half of a bad change behind.
- **It re-validates.** A [tool](/docs/modules/tools), provider, or [guardrail](/docs/modules/guardrails) deleted since the snapshot was taken fails the request loudly instead of writing a broken agent.

---

## What you built

| Need | Mechanism |
| --- | --- |
| "What did this prompt say last week?" | `list-agent-versions` / `get-agent-version` |
| "Try the new prompt on 10% of users" | `set-agent-release --canary-percent 10` |
| "Don't flip users between personas" | Deterministic assignment by actor, then session |
| "Which config produced this answer?" | `agent_version` on the generation record |
| "Ship it" / "Get it off production" | `promote-agent-release` / `abort-agent-release` |
| "Go back to the version from Tuesday" | `restore-agent-version` — as a new version |

Read next: [Agents — Versioning and Staged Rollout](/docs/modules/agents#versioning-and-staged-rollout), [Generations](/docs/modules/generations), and [Debug Session, Generation, and Trace History](/docs/tutorials/debug-session-generation-trace-history) for tracing a specific answer back to the config that produced it.
