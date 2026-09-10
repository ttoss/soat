---
description: "Give an agent access to platform documents with builtin tools, and lock a tool to a document ID using preset parameters."
keywords:
  - AI agent tools
  - tool calling
  - preset parameters
  - document tools
  - agent permissions
sidebar_position: 4
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent SOAT Tools and Preset Parameters

Give an agent access to platform documents with builtin tools, and lock a tool to one document ID with preset parameters. You create a public and a private note, a restricted user alice, three builtin tools (`docs_list-documents`, `docs_get-document`, `docs_update-document` with the public document's ID preset) and an agent, then verify the agent updates the right document and alice's policy blocks the private one.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)).
- Ollama at `http://ollama:11434` with `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- CLI, SDK, or curl; server at `http://localhost:5047`.

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

Admin bypasses policy evaluation — see [IAM — Authentication](/docs/modules/iam#authentication).

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

Every resource lives inside a [project](/docs/modules/projects#examples).

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

A local Ollama [AI provider](/docs/modules/ai-providers#examples). For other providers see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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

## Step 4 — Create documents

Two [documents](/docs/modules/documents#examples): a public note the agent updates and a private note it must not touch.

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

Alice may run agent generations and access documents under `/notes/public/*` only. See [Users](/docs/modules/users#examples), [Policies](/docs/modules/policies#examples) and [IAM — SRNs](/docs/modules/iam#soat-resource-names-srns).

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
        "resource": ["srn:'"$PROJECT_ID"':document:/notes/public/*"]
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
    document: {
      statement: [
        { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
        { effect: 'Allow', action: ['documents:ListDocuments'] },
        {
          effect: 'Allow',
          action: ['documents:GetDocument', 'documents:UpdateDocument'],
          resource: [`srn:${projectId}:document:/notes/public/*`],
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
          \"resource\": [\"srn:$PROJECT_ID:document:/notes/public/*\"]
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

## Step 6 — Create builtin tools

Three [tools](/docs/modules/tools#examples). `docs-write` carries `preset_parameters` with the public document's ID, keyed by the snake_case wire name (`document_id`); the model never sees the field and the server injects it at call time.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Tool 1 — list documents
LIST_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type builtin \
  --actions '["list-documents"]' | jq -r '.id')

# Tool 2 — read any document (model supplies document_id)
READ_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type builtin \
  --actions '["get-document"]' | jq -r '.id')

# Tool 3 — update the public document (document_id is preset)
WRITE_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "docs" \
  --type builtin \
  --actions '["update-document"]' \
  --preset-parameters '{"document_id": "'"$PUBLIC_DOC_ID"'"}' | jq -r '.id')

echo "List:  $LIST_TOOL_ID"
echo "Read:  $READ_TOOL_ID"
echo "Write: $WRITE_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: listTool } = await adminSoat.tools.createTool({
  body: {
    project_id: projectId,
    name: 'docs',
    type: 'soat',
    actions: ['list-documents'],
  },
});

const { data: readTool } = await adminSoat.tools.createTool({
  body: {
    project_id: projectId,
    name: 'docs',
    type: 'soat',
    actions: ['get-document'],
  },
});

// document_id is preset — the model never sees this parameter
const { data: writeTool } = await adminSoat.tools.createTool({
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
    \"preset_parameters\": {\"document_id\": \"$PUBLIC_DOC_ID\"}
  }" | jq -r '.id')

echo "List:  $LIST_TOOL_ID"
echo "Read:  $READ_TOOL_ID"
echo "Write: $WRITE_TOOL_ID"
```

</TabItem>
</Tabs>

Tool names the model sees:

| Tool name              | Action            | `document_id` visible to model?            |
| ---------------------- | ----------------- | ------------------------------------------ |
| `docs_list-documents`  | list documents    | N/A                                        |
| `docs_get-document`    | read a document   | yes — model supplies it                    |
| `docs_update-document` | update a document | **no** — injected from `preset_parameters` |

---

## Step 7 — Create the agent

Create the [agent](/docs/modules/agents#examples) with all three tools attached.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$PROVIDER_ID" \
  --name "Notes Agent" \
  --instructions "You are a note-taking assistant. Use your tools to list, read, and update documents." \
  --tool-bindings "[{\"tool_id\":\"$LIST_TOOL_ID\"},{\"tool_id\":\"$READ_TOOL_ID\"},{\"tool_id\":\"$WRITE_TOOL_ID\"}]" | jq -r '.id')
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
    tool_bindings: [{ tool_id: listToolId }, { tool_id: readToolId }, { tool_id: writeToolId }],
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
    \"tool_bindings\": [{ \"tool_id\": \"$LIST_TOOL_ID\" }, { \"tool_id\": \"$READ_TOOL_ID\" }, { \"tool_id\": \"$WRITE_TOOL_ID\" }]
  }" | jq -r '.id')
echo "Agent: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Log in as alice and run a generation

Alice asks the agent to update the public note via a [session](/docs/modules/sessions#examples). The agent calls `docs_update-document` without the document ID; the server injects it from `preset_parameters`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Log in as alice
ALICE_TOKEN=$(soat login-user --username alice-agent-soat-tools --password Alice1234! | jq -r '.token')

# Run the generation
RESULT=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
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
  query: { wait: true },
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

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
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

### Reuse a tool result as the generation input

A generation can start with [message content](/docs/modules/agents#tool-output-message-content) of type `tool_output`: the server executes the referenced tool, applies `output_path`, and feeds the extracted value to the model as the user message.

`messages` carries user and assistant turns only; steer the agent with its [`instructions`](/docs/modules/agents#instructions). A `role: "system"` entry is rejected with `400 SYSTEM_MESSAGE_NOT_ALLOWED`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TOOL_OUTPUT_RESULT=$(soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[
    {
      "role":"user",
      "content": {
        "type": "tool_output",
        "tool_id": "'"$READ_TOOL_ID"'",
        "action": "get-document",
        "input": {"document_id": "'"$PUBLIC_DOC_ID"'"},
        "output_path": ".content"
      }
    }
  ]')

echo "$TOOL_OUTPUT_RESULT" | jq '.'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: toolOutputGeneration } =
  await aliceClient.agents.createAgentGeneration({
    path: { agent_id: agentId },
    query: { wait: true },
    body: {
      messages: [
        {
          role: 'user',
          content: {
            type: 'tool_output',
            tool_id: readToolId,
            action: 'get-document',
            input: { document_id: publicDocId },
            output_path: '.content',
          },
        },
      ],
    },
  });

console.log('Status:', toolOutputGeneration!.status);
console.log('Result:', toolOutputGeneration!.result);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": {
          "type": "tool_output",
          "tool_id": "'"$READ_TOOL_ID"'",
          "action": "get-document",
          "input": {"document_id": "'"$PUBLIC_DOC_ID"'"},
          "output_path": ".content"
        }
      }
    ]
  }' | jq '.'
```

</TabItem>
</Tabs>

---

## Step 9 — Verify the update and permissions

Confirm the public [document](/docs/modules/documents#examples) was updated and the private one is blocked by alice's [IAM policy](/docs/modules/iam#authorization-model).

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

Asking the agent to update the private note yields a 403 on `docs_get-document`, which the agent reports back.

---

## Step 10 — Call a tool directly via REST

Any non-client [tool](/docs/modules/tools#examples) can be invoked without an agent or generation. The `list-documents` tool from step 6 has `project_id` preset, so the body needs no parameters.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat call-tool \
  --tool-id "$LIST_TOOL_ID" \
  --action "list-documents"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: result } = await aliceSoat.tools.callTool({
  params: { path: { tool_id: listToolId } },
  body: {
    action: 'list-documents',
  },
});

console.log(result);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tools/$LIST_TOOL_ID/call" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "list-documents"}'
```

</TabItem>
</Tabs>

`preset_parameters` are merged before dispatch and alice's IAM policy still applies. For `http` tools omit `action` and pass parameters in `input`; for `mcp` tools set `action` to the MCP tool name.

---

## What happened

1. `docs-write` stored `{ "document_id": "<public doc id>" }` as `preset_parameters`; the server stripped `document_id` from the schema shown to the model (preset keys are the tool's snake_case parameter names).
2. The model saw `docs_update-document` accepting only `content`, `title`, `path`, `metadata` and `tags`, so it could not supply a wrong ID.
3. On call, the server merged `document_id` back in before dispatching [`PATCH /api/v1/documents/{document_id}`](/docs/api/documents/update-document).
4. The request ran under alice's JWT; her policy allows `documents:UpdateDocument` on `/notes/public/note.txt`, and paths outside `/notes/public/*` return 403.

---

## Next steps

- Add more actions (e.g. `search-knowledge`) to the tools.
- [Step rules](/docs/modules/agents#step-rules) — force a specific tool call first.
- [Boundary policies](/docs/modules/agents#soat-action-permissions) — cap actions per agent, independent of the caller.
- [Agents reference](/docs/modules/agents#examples) — all soat actions and options.
