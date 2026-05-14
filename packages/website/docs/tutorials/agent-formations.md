---
sidebar_position: 7
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Deploy an Agent App with Agent Formation

This tutorial shows how to use [Agent Formation](/docs/modules/agent-formations) to deploy a complete AI agent application — including an AI provider, memory, and agent — with a single declarative template instead of many ordered API calls.

You will:

1. Write a formation template that describes the desired resources.
2. Validate the template to catch structural errors before deploying.
3. Preview the deployment plan to see what resources will be created.
4. Deploy the formation and retrieve the output IDs.
5. Update the formation to change a resource property.
6. Delete the formation and all its managed resources.

By the end you will understand how Agent Formation turns a multi-step SOAT workflow into one reproducible operation.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and the IAM model before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

All code snippets below use a `SoatClient` instance created in Step 1.

```ts
import {
  SoatClient,
  createClient,
  createConfig,
  AgentFormations,
} from '@soat/sdk';
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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [Users](/docs/modules/users) for full authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password Admin1234!
soat configure
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const ADMIN_TOKEN = login.token;

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: ADMIN_TOKEN,
});
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

## Step 2 — Create a project

Every resource in SOAT lives inside a [project](/docs/modules/projects). Create one to hold the formation.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Agent Formation Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Agent Formation Demo' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Agent Formation Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Write the formation template

A [formation template](/docs/modules/agent-formations) is a JSON object with a `resources` map and an optional `outputs` map. Each resource has a `type`, `properties`, and optional `depends_on`. References between resources use `{ "ref": "logicalId" }` expressions.

This template creates a local Ollama AI provider, a memory for the agent to read from, and an agent that wires them together:

```json
{
  "resources": {
    "provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Formation Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "profileMemory": {
      "type": "memory",
      "properties": {
        "name": "Formation Profile Memory",
        "tags": ["formation", "demo"]
      }
    },
    "assistant": {
      "type": "agent",
      "properties": {
        "name": "Formation Assistant",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "Answer helpfully from the knowledge base.",
        "knowledge_config": {
          "memory_ids": [{ "ref": "profileMemory" }],
          "write_memory_id": { "ref": "profileMemory" }
        }
      }
    }
  },
  "outputs": {
    "agent_id": { "ref": "assistant" },
    "memory_id": { "ref": "profileMemory" },
    "provider_id": { "ref": "provider" }
  }
}
```

This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

Store the template in a variable:

```bash
TEMPLATE=$(jq -n \
  '{"resources":{"provider":{"type":"ai_provider","properties":{"name":"Formation Ollama","provider":"ollama","default_model":"qwen2.5:0.5b"}},"profileMemory":{"type":"memory","properties":{"name":"Formation Profile Memory","tags":["formation","demo"]}},"assistant":{"type":"agent","properties":{"name":"Formation Assistant","ai_provider_id":{"ref":"provider"},"instructions":"Answer helpfully from the knowledge base.","knowledge_config":{"memory_ids":[{"ref":"profileMemory"}],"write_memory_id":{"ref":"profileMemory"}}}}},"outputs":{"agent_id":{"ref":"assistant"},"memory_id":{"ref":"profileMemory"},"provider_id":{"ref":"provider"}}}')
```

</TabItem>
<TabItem value="curl" label="curl">

Save this template to a file:

```bash
cat > formation.json << 'EOF'
{
  "resources": {
    "provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Formation Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "profileMemory": {
      "type": "memory",
      "properties": {
        "name": "Formation Profile Memory",
        "tags": ["formation", "demo"]
      }
    },
    "assistant": {
      "type": "agent",
      "properties": {
        "name": "Formation Assistant",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "Answer helpfully from the knowledge base.",
        "knowledge_config": {
          "memory_ids": [{ "ref": "profileMemory" }],
          "write_memory_id": { "ref": "profileMemory" }
        }
      }
    }
  },
  "outputs": {
    "agent_id": { "ref": "assistant" },
    "memory_id": { "ref": "profileMemory" },
    "provider_id": { "ref": "provider" }
  }
}
EOF
TEMPLATE=$(cat formation.json)
```

</TabItem>
</Tabs>

---

## Step 4 — Validate the template

The validate endpoint checks structure without creating any resources. It is safe to call as many times as needed. See [Agent Formation](/docs/modules/agent-formations) for the full validation rules.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat validate-agent-formation --template "$TEMPLATE"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { readFileSync } from 'fs';
const template = JSON.parse(readFileSync('formation.json', 'utf-8'));

const authClient = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  })
);

const { data: validation } = await AgentFormations.validateAgentFormation({
  client: authClient,
  body: { template },
});
console.log(validation.valid); // true
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TEMPLATE=$(cat formation.json)
curl -s -X POST "$SOAT_URL/api/v1/agent-formations/validate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"template\": $TEMPLATE}"
```

</TabItem>
</Tabs>

Expected output:

```json
{ "valid": true, "errors": [] }
```

---

## Step 5 — Preview the deployment plan

The plan endpoint computes what would happen if you deployed the template now — which resources would be created, updated, or deleted. No resources are touched. See [Agent Formation — Planning](/docs/modules/agent-formations) for details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat plan-agent-formation --project_id "$PROJECT_ID" --template "$TEMPLATE"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: plan } = await AgentFormations.planAgentFormation({
  client: authClient,
  body: { project_id: PROJECT_ID, template },
});
console.log(plan.actions);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TEMPLATE=$(cat formation.json)
curl -s -X POST "$SOAT_URL/api/v1/agent-formations/plan" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"template\": $TEMPLATE}"
```

</TabItem>
</Tabs>

The response lists each resource with an `action` of `create`, `update`, or `none`.

---

## Step 6 — Deploy the formation

Create the formation to provision all resources in dependency order. SOAT resolves `{ "ref": ... }` expressions after each resource is created, so the agent receives the real AI provider and memory IDs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FORMATION=$(soat create-agent-formation \
  --project_id "$PROJECT_ID" \
  --name "my-agent-app" \
  --template "$TEMPLATE")
FORMATION_ID=$(echo "$FORMATION" | jq -r '.id')
echo "FORMATION_ID: $FORMATION_ID"
echo "Outputs: $(echo "$FORMATION" | jq '.outputs')"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: formation } = await AgentFormations.createAgentFormation({
  client: authClient,
  body: {
    project_id: PROJECT_ID,
    name: 'my-agent-app',
    template,
  },
});
const FORMATION_ID = formation.id;
console.log('Outputs:', formation.outputs);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TEMPLATE=$(cat formation.json)
FORMATION=$(curl -s -X POST "$SOAT_URL/api/v1/agent-formations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"name\": \"my-agent-app\", \"template\": $TEMPLATE}")
FORMATION_ID=$(echo "$FORMATION" | jq -r '.id')
echo "FORMATION_ID: $FORMATION_ID"
echo "Outputs: $(echo "$FORMATION" | jq '.outputs')"
```

</TabItem>
</Tabs>

The `outputs` field in the response contains the physical SOAT IDs for `agent_id`, `memory_id`, and `provider_id`. You can use these IDs directly with the [Agents](/docs/modules/agents) API to start a conversation.

---

## Step 7 — Inspect the deployed stack

Retrieve the formation to see its current status, managed resources, and resolved outputs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-agent-formation --formation_id "$FORMATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: stack } = await AgentFormations.getAgentFormation({
  client: authClient,
  path: { formation_id: FORMATION_ID },
});
console.log(stack.status); // "active"
console.log(stack.resources); // array of provisioned resources
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/agent-formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

The `resources` array shows each logical ID mapped to a physical resource ID and its status (`created`, `updated`, or `deleted`).

---

## Step 8 — Update the formation

Change the agent instructions and redeploy. SOAT computes a diff and updates only the resources that changed.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
UPDATED_TEMPLATE=$(printf '%s' "$TEMPLATE" | jq '.resources.assistant.properties.instructions = "Answer concisely from the knowledge base."')
soat update-agent-formation \
  --formation_id "$FORMATION_ID" \
  --template "$UPDATED_TEMPLATE"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const updatedTemplate = {
  ...template,
  resources: {
    ...template.resources,
    assistant: {
      ...template.resources.assistant,
      properties: {
        ...template.resources.assistant.properties,
        instructions: 'Answer concisely from the knowledge base.',
      },
    },
  },
};

const { data: updated } = await AgentFormations.updateAgentFormation({
  client: authClient,
  path: { formation_id: FORMATION_ID },
  body: { template: updatedTemplate },
});
console.log(updated.status); // "active"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
UPDATED_TEMPLATE=$(cat formation.json | jq '.resources.assistant.properties.instructions = "Answer concisely from the knowledge base."')
curl -s -X PUT "$SOAT_URL/api/v1/agent-formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"template\": $UPDATED_TEMPLATE}"
```

</TabItem>
</Tabs>

---

## Step 9 — View operation events

Each mutating operation records events you can inspect to understand what happened, especially useful when a deployment partially fails. See [Agent Formation — Operations](/docs/modules/agent-formations) for the event schema.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-agent-formation-events --formation_id "$FORMATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: events } = await AgentFormations.listAgentFormationEvents({
  client: authClient,
  path: { formation_id: FORMATION_ID },
});
events.forEach((op) => {
  console.log(op.operation_type, op.status, op.events);
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/agent-formations/$FORMATION_ID/events" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

---

## Step 10 — Delete the formation

Deleting a formation removes the formation record and all SOAT resources it created, in reverse dependency order.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat delete-agent-formation --formation_id "$FORMATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await AgentFormations.deleteAgentFormation({
  client: authClient,
  path: { formation_id: FORMATION_ID },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X DELETE "$SOAT_URL/api/v1/agent-formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

Confirm the formation is gone:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat get-agent-formation --formation_id "$FORMATION_ID"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "$SOAT_URL/api/v1/agent-formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Prints 404
```

</TabItem>
</Tabs>

---

## Summary

You deployed a multi-resource AI agent application using a single formation template. The key ideas:

- **Validate** before deploying to catch structural errors early.
- **Plan** to preview changes before they happen.
- **`ref` expressions** wire resources together; SOAT resolves them in dependency order.
- **Outputs** give you the physical IDs of deployed resources without manually tracking them.
- **Update** reruns the apply logic and only changes what differs.
- **Delete** tears down all managed resources in one call.

For the full API reference, see [Agent Formation](/docs/modules/agent-formations).
