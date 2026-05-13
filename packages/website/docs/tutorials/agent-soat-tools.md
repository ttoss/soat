---
sidebar_position: 5
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent SOAT Tools and Preset Parameters

This tutorial shows how to give an agent access to platform documents using **soat tools** — and how to use **preset parameters** to lock a tool to a specific document ID so the model never has to guess it.

You will:

1. Log in as admin.
2. Create a project and an Ollama AI provider.
3. Create two documents: a **public** note and a **private** note.
4. Create a user **alice** with a policy that restricts her to the public document path.
5. Create three soat tools:
   - `docs_list-documents` — lists documents in the project.
   - `docs_get-document` — reads any document by ID (model supplies the ID).
   - `docs_update-document` — updates the public document (ID is **preset**; model never sees it).
6. Create an agent that uses these tools and attach it to alice's project.
7. Run a generation as alice and observe the agent updating the correct document without being told its ID.
8. Verify that alice cannot read or update the private document (permissions enforcement).

By the end you will understand:

- How to wire agent-side document tooling.
- How `preset_parameters` eliminates the probabilistic risk of the model choosing the wrong ID.
- How IAM policies are enforced even when an agent calls platform APIs on behalf of a user.

## Prerequisites

- SOAT running locally with Ollama. Follow the [Quick Start](/docs/getting-started) guide.
- An Ollama instance accessible at `http://ollama:11434` with model `qwen2.5:3b` pulled (`ollama pull qwen2.5:3b`).
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

Every resource in SOAT lives inside a [project](/docs/modules/projects). Create one to hold the agent, documents, and tools.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Notes Project" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Notes Project' },
});
const projectId = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Notes Project"}' | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an Ollama AI provider

Set up a local [AI provider](/docs/modules/ai-providers) backed by Ollama. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:3b" | jq -r '.id')
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
    default_model: 'qwen2.5:3b',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:3b\"}" | jq -r '.id')
echo "Provider: $PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create documents

Create two [documents](/docs/modules/documents): a **public** note the agent will update, and a **private** note it must not touch.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PUBLIC_DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --title "Public Note" \
  --content "Initial public content." \
  --path "/notes/public/note.txt" | jq -r '.id')
echo "Public doc: $PUBLIC_DOC_ID"

PRIVATE_DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --title "Private Note" \
  --content "Confidential information." \
  --path "/notes/private/note.txt" | jq -r '.id')
echo "Private doc: $PRIVATE_DOC_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: publicDoc } = await adminSoat.documents.createDocument({
  body: {
    project_id: projectId,
    title: 'Public Note',
    content: 'Initial public content.',
    path: '/notes/public/note.txt',
  },
});
const publicDocId = publicDoc!.id;

const { data: privateDoc } = await adminSoat.documents.createDocument({
  body: {
    project_id: projectId,
    title: 'Private Note',
    content: 'Confidential information.',
    path: '/notes/private/note.txt',
  },
});
const privateDocId = privateDoc!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PUBLIC_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"title\": \"Public Note\",
    \"content\": \"Initial public content.\",
    \"path\": \"/notes/public/note.txt\"
  }" | jq -r '.id')
echo "Public doc: $PUBLIC_DOC_ID"

PRIVATE_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"title\": \"Private Note\",
    \"content\": \"Confidential information.\",
    \"path\": \"/notes/private/note.txt\"
  }" | jq -r '.id')
echo "Private doc: $PRIVATE_DOC_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create user alice with a restricted policy

Alice is allowed to run agent generations and access documents under `/notes/public/*`. She cannot read or modify documents at other paths. See [Users](/docs/modules/users), [Policies](/docs/modules/policies), and [IAM — SRNs](/docs/modules/iam#soat-resource-names-srns) for the full access-control model.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ALICE_ID=$(soat create-user --username alice-agent-soat-tools --password Alice1234! | jq -r '.id')
echo "Alice: $ALICE_ID"

POLICY_ID=$(soat create-policy \
  --name "alice-agent-soat-tools-notes-policy" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["agents:CreateAgentGeneration"]
      },
      {
        "effect": "Allow",
        "action": ["documents:ListDocuments"]
      },
      {
        "effect": "Allow",
        "action": ["documents:GetDocument", "documents:UpdateDocument"],
        "resource": ["soat:'"$PROJECT_ID"':document:/notes/public/*"]
      }
    ]
  }' | jq -r '.id')

soat attach-user-policies \
  --user-id "$ALICE_ID" \
  --policy-ids '["'"$POLICY_ID"'"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: alice } = await adminSoat.users.createUser({
  body: { username: 'alice-agent-soat-tools', password: 'Alice1234!' },
});
const aliceId = alice!.id;

const { data: policy } = await adminSoat.policies.createPolicy({
  body: {
    name: 'alice-agent-soat-tools-notes-policy',
    policy: {
      statement: [
        { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
        { effect: 'Allow', action: ['documents:ListDocuments'] },
        {
          effect: 'Allow',
          action: ['documents:GetDocument', 'documents:UpdateDocument'],
          resource: [`soat:${projectId}:document:/notes/public/*`],
        },
      ],
    },
  },
});

await adminSoat.users.attachUserPolicies({
  path: { user_id: aliceId },
  body: { policy_ids: [policy!.id] },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ALICE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice-agent-soat-tools","password":"Alice1234!"}' | jq -r '.id')
echo "Alice: $ALICE_ID"

POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"alice-agent-soat-tools-notes-policy\",
    \"policy\": {
      \"statement\": [
        {\"effect\": \"Allow\", \"action\": [\"agents:CreateAgentGeneration\"]},
        {\"effect\": \"Allow\", \"action\": [\"documents:ListDocuments\"]},
        {
          \"effect\": \"Allow\",
          \"action\": [\"documents:GetDocument\", \"documents:UpdateDocument\"],
          \"resource\": [\"soat:$PROJECT_ID:document:/notes/public/*\"]
        }
      ]
    }
  }" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/policies/attach-user" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\": \"$ALICE_ID\", \"policy_id\": \"$POLICY_ID\"}"
```

</TabItem>
</Tabs>

---

## Step 6 — Create soat tools

Create three [agent tools](/docs/modules/agents#agent-tool). Notice the third tool — `docs-write` — has `preset_parameters` containing the public document's ID. The key uses **camelCase** (`documentId`) because soat tool schemas use camelCase property names internally. The model will never see the `documentId` field; it will be injected automatically at call time.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Tool 1 — list documents
LIST_TOOL_ID=$(soat create-agent-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type soat \
  --actions '["list-documents"]' | jq -r '.id')

# Tool 2 — read any document (model supplies document_id)
READ_TOOL_ID=$(soat create-agent-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type soat \
  --actions '["get-document"]' | jq -r '.id')

# Tool 3 — update the public document (document_id is preset)
WRITE_TOOL_ID=$(soat create-agent-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type soat \
  --actions '["update-document"]' \
  --preset-parameters '{"documentId": "'"$PUBLIC_DOC_ID"'"}' | jq -r '.id')

echo "List:  $LIST_TOOL_ID"
echo "Read:  $READ_TOOL_ID"
echo "Write: $WRITE_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: listTool } = await adminSoat.agents.createAgentTool({
  body: {
    project_id: projectId,
    name: 'docs',
    type: 'soat',
    actions: ['list-documents'],
  },
});

const { data: readTool } = await adminSoat.agents.createAgentTool({
  body: {
    project_id: projectId,
    name: 'docs',
    type: 'soat',
    actions: ['get-document'],
  },
});

// document_id is preset — the model never sees this parameter
const { data: writeTool } = await adminSoat.agents.createAgentTool({
  body: {
    project_id: projectId,
    name: 'docs',
    type: 'soat',
    actions: ['update-document'],
    preset_parameters: { document_id: publicDocId },
  },
});

const listToolId = listTool!.id;
const readToolId = readTool!.id;
const writeToolId = writeTool!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
LIST_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"docs\",
    \"type\": \"soat\",
    \"actions\": [\"list-documents\"]
  }" | jq -r '.id')

READ_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"docs\",
    \"type\": \"soat\",
    \"actions\": [\"get-document\"]
  }" | jq -r '.id')

WRITE_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"docs\",
    \"type\": \"soat\",
    \"actions\": [\"update-document\"],
    \"preset_parameters\": {\"documentId\": \"$PUBLIC_DOC_ID\"}
  }" | jq -r '.id')

echo "List:  $LIST_TOOL_ID"
echo "Read:  $READ_TOOL_ID"
echo "Write: $WRITE_TOOL_ID"
```

</TabItem>
</Tabs>

The three tool names the model will see at runtime are:

| Tool name              | Action            | `document_id` visible to model?            |
| ---------------------- | ----------------- | ------------------------------------------ |
| `docs_list-documents`  | list documents    | N/A                                        |
| `docs_get-document`    | read a document   | yes — model supplies it                    |
| `docs_update-document` | update a document | **no** — injected from `preset_parameters` |

---

## Step 7 — Create the agent

Create the [agent](/docs/modules/agents) and attach all three tools. The agent's instructions guide the model to use its tools when answering requests.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name "Notes Agent" \
  --instructions "You are a note-taking assistant. Use your tools to list, read, and update documents." \
  --tool-ids "[\"$LIST_TOOL_ID\", \"$READ_TOOL_ID\", \"$WRITE_TOOL_ID\"]" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: projectId,
    ai_provider_id: providerId,
    name: 'Notes Agent',
    instructions:
      'You are a note-taking assistant. Use your tools to list, read, and update documents.',
    tool_ids: [listToolId, readToolId, writeToolId],
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
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"ai_provider_id\": \"$PROVIDER_ID\",
    \"name\": \"Notes Agent\",
    \"instructions\": \"You are a note-taking assistant. Use your tools to list, read, and update documents.\",
    \"tool_ids\": [\"$LIST_TOOL_ID\", \"$READ_TOOL_ID\", \"$WRITE_TOOL_ID\"]
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Log in as alice and run a generation

Alice asks the agent to update the public note via a [session](/docs/modules/sessions). The agent will call `docs_update-document` without knowing the document ID — the server injects it from `preset_parameters`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Log in as alice
ALICE_TOKEN=$(soat login-user --username alice-agent-soat-tools --password Alice1234! | jq -r '.token')

# Run the generation
RESULT=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "Please update the public note with the content: Updated by the agent."
      }
    ]
  }')

echo "$RESULT" | jq '.'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Log in as alice
const aliceSoat = new SoatClient({ baseUrl: 'http://localhost:5047' });
const { data: aliceSession } = await aliceSoat.users.loginUser({
  body: { username: 'alice-agent-soat-tools', password: 'Alice1234!' },
});

const aliceClient = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: aliceSession!.token,
});

// Run the generation
const { data: generation } = await aliceClient.agents.createAgentGeneration({
  path: { agent_id: agentId },
  body: {
    messages: [
      {
        role: 'user',
        content:
          'Please update the public note with the content: Updated by the agent.',
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
ALICE_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice-agent-soat-tools","password":"Alice1234!"}' | jq -r '.token')

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "Please update the public note with the content: Updated by the agent."
      }
    ]
  }' | jq '.'
```

</TabItem>
</Tabs>

---

## Step 9 — Verify the update and permissions

Confirm the agent updated the public [document](/docs/modules/documents) and was blocked from accessing the private one. This demonstrates how [IAM policies](/docs/modules/iam#authorization-model) enforce path-based access at runtime.

### Confirm the public document was updated

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-document --document-id "$PUBLIC_DOC_ID" | jq '.content'
# Expected: "Updated by the agent."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: updated } = await adminSoat.documents.getDocument({
  path: { document_id: publicDocId },
});
console.log('Content:', updated!.content);
// Expected: "Updated by the agent."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/documents/$PUBLIC_DOC_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.content'
# Expected: "Updated by the agent."
```

</TabItem>
</Tabs>

### Confirm alice cannot read the private document

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
curl -s "$SOAT_BASE_URL/api/v1/documents/$PRIVATE_DOC_ID" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.'
# Expected: 403 Forbidden
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await aliceClient.documents.getDocument({
  path: { document_id: privateDocId },
});
console.log('Error:', error);
// Expected: 403 Forbidden
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/documents/$PRIVATE_DOC_ID" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.'
# Expected: 403 Forbidden
```

</TabItem>
</Tabs>

The private document is inaccessible. If you asked the agent to update the private note, it would receive a 403 when trying to call `docs_get-document` with the private document's ID, and would report back that it is not permitted.

---

## What happened

1. **Tool creation with `preset_parameters`**: When you created `docs-write`, you stored `{ "documentId": "<public doc id>" }` alongside the tool. The server stripped `documentId` from the schema before registering the tool with the model (preset keys must use the **camelCase** form of the parameter name).

2. **Model's view**: The model saw `docs_update-document` accepting only `content`, `title`, `path`, `metadata`, and `tags` — no `documentId` in sight. This eliminates the risk of the model supplying a wrong or hallucinated ID.

3. **Execution**: When the model called `docs_update-document`, the server merged the preset `document_id` back in before dispatching the `PATCH /api/v1/documents/{document_id}` request.

4. **Permission enforcement**: The request ran under alice's JWT. The platform's document permission check verified that alice's policy allows `documents:UpdateDocument` for the path `/notes/public/note.txt`. The private document path falls outside `/notes/public/*`, so any attempt there returns 403.

---

## Next steps

- Add more actions to the tools (e.g., `search-documents`) for richer agent workflows.
- Use [step rules](/docs/modules/agents#step-rules) to force the agent to call a specific tool first.
- Explore [boundary policies](/docs/modules/agents#soat-action-permissions) to limit which actions agents can use at the agent level, independent of caller IAM policies.
- Read the [agents module reference](/docs/modules/agents) for the full list of soat actions and configuration options.
