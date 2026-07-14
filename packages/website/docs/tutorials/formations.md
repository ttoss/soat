---
sidebar_position: 16
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Deploy a Multi-Agent App with Agent Formation

This tutorial builds the same **multi-agent orchestration** pipeline from [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration) — an orchestrator agent that delegates sonnet stanzas to four specialized sub-agents — but deploys the entire system with a **single [Agent Formation](/docs/modules/formations#key-concepts) template** instead of many ordered API calls.

You will:

1. Write a formation template that describes all 14 resources: an AI provider, a shared poem document, agent tools, four stanza workers, and an orchestrator.
2. Validate and preview the template before deploying.
3. Deploy the entire system in one call, with SOAT resolving all `{ "ref": ... }` cross-resource references automatically.
4. Run the orchestrator and read the finished poem.
5. Update the formation to change a resource.
6. Delete the formation and all its managed resources.

By the end you will understand how [Agent Formation](/docs/modules/formations#key-concepts) turns a complex multi-step workflow into one reproducible, declarative operation.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and sessions before diving in.
- Want to see the same pipeline built step by step? Read [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration) first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/getting-started/advanced-config).
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` pulled (`ollama pull qwen2.5:0.5b`).
- Server is at `http://localhost:5047`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { createConfig, SoatClient } from '@soat/sdk';

const config = createConfig({
  baseUrl: 'http://localhost:5047',
  auth: '',
});
const adminSoat = new SoatClient(config);
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

Admin is the built-in superuser. See [Users](/docs/modules/users#examples) for full authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session } = await adminSoat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});
const ADMIN_TOKEN = session.token;
const authConfig = createConfig({
  baseUrl: 'http://localhost:5047',
  auth: ADMIN_TOKEN,
});
const authClient = new SoatClient(authConfig);
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

All resources are scoped to a [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name 'Sonnet Workshop' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await authClient.projects.createProject({
  body: { name: 'Sonnet Workshop' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sonnet Workshop"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Write the formation template

A [formation template](/docs/modules/formations#key-concepts) is a JSON object with a `resources` map and an optional `outputs` map. This single template defines all 14 resources of the sonnet pipeline. SOAT resolves `{ "ref": "logicalId" }` expressions in dependency order so `tool_ids`, `ai_provider_id`, and nested `preset_parameters.agentId` are all wired automatically — no manual ID tracking required.

The template defines:

- **`provider`** — Ollama AI provider (no dependencies)
- **`poemDoc`** — shared poem document (no dependencies)
- **`poemReadTool` / `poemWriteTool`** — fixed document tools for stanza agents (depend on `poemDoc`)
- **`stanza1Agent` … `stanza4Agent`** — worker agents with fixed step rules (depend on `provider`, `poemReadTool`, `poemWriteTool`)
- **`callStanza1Tool` … `callStanza4Tool`** — fixed orchestrator tools with `preset_parameters.agentId` wired to each stanza agent via `ref` (depend on respective stanza agents)
- **`readFinalPoemTool`** — orchestrator's final read tool (depends on `poemDoc`)
- **`orchestrator`** — coordinates the full pipeline (depends on `provider` and all five orchestrator tools)

This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
cat > formation.json << 'EOF'
{
  "resources": {
    "provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Sonnet Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "poemDoc": {
      "type": "document",
      "properties": {
        "content": "(empty - will be overwritten by stanza agents)",
        "path": "/poems/sonnet.txt"
      }
    },
    "poemReadTool": {
      "type": "tool",
      "properties": {
        "name": "poem-read",
        "type": "soat",
        "description": "Read the shared poem document",
        "actions": ["get-document"],
        "preset_parameters": { "documentId": { "ref": "poemDoc" } }
      }
    },
    "poemWriteTool": {
      "type": "tool",
      "properties": {
        "name": "poem-write",
        "type": "soat",
        "description": "Update the shared poem document",
        "actions": ["update-document"],
        "preset_parameters": { "documentId": { "ref": "poemDoc" } }
      }
    },
    "stanza1Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 1 - First Quatrain",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 1. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the poem title on the first line, add a blank line, then write the FIRST quatrain (4 lines) using ABAB. In poem-write, set content to the full poem-so-far including your stanza.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "stanza2Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 2 - Second Quatrain",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 2. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the SECOND quatrain (4 lines) using CDCD. In poem-write, set content to the full poem-so-far including your stanza.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "stanza3Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 3 - Third Quatrain",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 3. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the THIRD quatrain (4 lines) using EFEF. In poem-write, set content to the full poem-so-far including your stanza.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "stanza4Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 4 - Final Couplet",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 4. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the FINAL couplet (2 lines) using GG. In poem-write, set content to the full poem-so-far including your couplet.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "callStanza1Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-1",
        "type": "soat",
        "description": "Call stanza 1 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza1Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 1 with title + first quatrain." }]
        }
      }
    },
    "callStanza2Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-2",
        "type": "soat",
        "description": "Call stanza 2 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza2Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 2 (second quatrain)." }]
        }
      }
    },
    "callStanza3Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-3",
        "type": "soat",
        "description": "Call stanza 3 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza3Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 3 (third quatrain)." }]
        }
      }
    },
    "callStanza4Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-4",
        "type": "soat",
        "description": "Call stanza 4 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza4Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 4 (final couplet)." }]
        }
      }
    },
    "readFinalPoemTool": {
      "type": "tool",
      "properties": {
        "name": "read-final-poem",
        "type": "soat",
        "description": "Read the final poem from the shared document",
        "actions": ["get-document"],
        "preset_parameters": { "documentId": { "ref": "poemDoc" } }
      }
    },
    "orchestrator": {
      "type": "agent",
      "properties": {
        "name": "Sonnet Orchestrator",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text.",
        "tool_ids": [
          { "ref": "callStanza1Tool" },
          { "ref": "callStanza2Tool" },
          { "ref": "callStanza3Tool" },
          { "ref": "callStanza4Tool" },
          { "ref": "readFinalPoemTool" }
        ],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "call-stanza-1_create-agent-generation" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "call-stanza-2_create-agent-generation" } },
          { "step": 3, "tool_choice": { "type": "tool", "tool_name": "call-stanza-3_create-agent-generation" } },
          { "step": 4, "tool_choice": { "type": "tool", "tool_name": "call-stanza-4_create-agent-generation" } },
          { "step": 5, "tool_choice": { "type": "tool", "tool_name": "read-final-poem_get-document" } }
        ],
        "max_steps": 8
      }
    }
  },
  "outputs": {
    "orchestrator_id": { "ref": "orchestrator" },
    "poem_doc_id": { "ref": "poemDoc" }
  }
}
EOF
TEMPLATE=$(cat formation.json)
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const template = {
  resources: {
    provider: {
      type: 'ai_provider',
      properties: {
        name: 'Sonnet Ollama',
        provider: 'ollama',
        default_model: 'qwen2.5:0.5b',
      },
    },
    poemDoc: {
      type: 'document',
      properties: {
        content: '(empty - will be overwritten by stanza agents)',
        path: '/poems/sonnet.txt',
      },
    },
    poemReadTool: {
      type: 'tool',
      properties: {
        name: 'poem-read',
        type: 'soat',
        description: 'Read the shared poem document',
        actions: ['get-document'],
        preset_parameters: { documentId: { ref: 'poemDoc' } },
      },
    },
    poemWriteTool: {
      type: 'tool',
      properties: {
        name: 'poem-write',
        type: 'soat',
        description: 'Update the shared poem document',
        actions: ['update-document'],
        preset_parameters: { documentId: { ref: 'poemDoc' } },
      },
    },
    stanza1Agent: {
      type: 'agent',
      properties: {
        name: 'Stanza 1 - First Quatrain',
        ai_provider_id: { ref: 'provider' },
        instructions:
          'You are deterministic stanza worker 1. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the poem title on the first line, add a blank line, then write the FIRST quatrain (4 lines) using ABAB. In poem-write, set content to the full poem-so-far including your stanza.',
        tool_ids: [{ ref: 'poemReadTool' }, { ref: 'poemWriteTool' }],
        step_rules: [
          {
            step: 1,
            tool_choice: { type: 'tool', tool_name: 'poem-read_get-document' },
          },
          {
            step: 2,
            tool_choice: {
              type: 'tool',
              tool_name: 'poem-write_update-document',
            },
          },
        ],
        max_steps: 5,
      },
    },
    stanza2Agent: {
      type: 'agent',
      properties: {
        name: 'Stanza 2 - Second Quatrain',
        ai_provider_id: { ref: 'provider' },
        instructions:
          'You are deterministic stanza worker 2. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the SECOND quatrain (4 lines) using CDCD. In poem-write, set content to the full poem-so-far including your stanza.',
        tool_ids: [{ ref: 'poemReadTool' }, { ref: 'poemWriteTool' }],
        step_rules: [
          {
            step: 1,
            tool_choice: { type: 'tool', tool_name: 'poem-read_get-document' },
          },
          {
            step: 2,
            tool_choice: {
              type: 'tool',
              tool_name: 'poem-write_update-document',
            },
          },
        ],
        max_steps: 5,
      },
    },
    stanza3Agent: {
      type: 'agent',
      properties: {
        name: 'Stanza 3 - Third Quatrain',
        ai_provider_id: { ref: 'provider' },
        instructions:
          'You are deterministic stanza worker 3. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the THIRD quatrain (4 lines) using EFEF. In poem-write, set content to the full poem-so-far including your stanza.',
        tool_ids: [{ ref: 'poemReadTool' }, { ref: 'poemWriteTool' }],
        step_rules: [
          {
            step: 1,
            tool_choice: { type: 'tool', tool_name: 'poem-read_get-document' },
          },
          {
            step: 2,
            tool_choice: {
              type: 'tool',
              tool_name: 'poem-write_update-document',
            },
          },
        ],
        max_steps: 5,
      },
    },
    stanza4Agent: {
      type: 'agent',
      properties: {
        name: 'Stanza 4 - Final Couplet',
        ai_provider_id: { ref: 'provider' },
        instructions:
          'You are deterministic stanza worker 4. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the FINAL couplet (2 lines) using GG. In poem-write, set content to the full poem-so-far including your couplet.',
        tool_ids: [{ ref: 'poemReadTool' }, { ref: 'poemWriteTool' }],
        step_rules: [
          {
            step: 1,
            tool_choice: { type: 'tool', tool_name: 'poem-read_get-document' },
          },
          {
            step: 2,
            tool_choice: {
              type: 'tool',
              tool_name: 'poem-write_update-document',
            },
          },
        ],
        max_steps: 5,
      },
    },
    callStanza1Tool: {
      type: 'tool',
      properties: {
        name: 'call-stanza-1',
        type: 'soat',
        description: 'Call stanza 1 agent',
        actions: ['create-agent-generation'],
        preset_parameters: {
          agentId: { ref: 'stanza1Agent' },
          messages: [
            {
              role: 'user',
              content:
                'Theme: artificial intelligence. Write stanza 1 with title + first quatrain.',
            },
          ],
        },
      },
    },
    callStanza2Tool: {
      type: 'tool',
      properties: {
        name: 'call-stanza-2',
        type: 'soat',
        description: 'Call stanza 2 agent',
        actions: ['create-agent-generation'],
        preset_parameters: {
          agentId: { ref: 'stanza2Agent' },
          messages: [
            {
              role: 'user',
              content:
                'Theme: artificial intelligence. Write stanza 2 (second quatrain).',
            },
          ],
        },
      },
    },
    callStanza3Tool: {
      type: 'tool',
      properties: {
        name: 'call-stanza-3',
        type: 'soat',
        description: 'Call stanza 3 agent',
        actions: ['create-agent-generation'],
        preset_parameters: {
          agentId: { ref: 'stanza3Agent' },
          messages: [
            {
              role: 'user',
              content:
                'Theme: artificial intelligence. Write stanza 3 (third quatrain).',
            },
          ],
        },
      },
    },
    callStanza4Tool: {
      type: 'tool',
      properties: {
        name: 'call-stanza-4',
        type: 'soat',
        description: 'Call stanza 4 agent',
        actions: ['create-agent-generation'],
        preset_parameters: {
          agentId: { ref: 'stanza4Agent' },
          messages: [
            {
              role: 'user',
              content:
                'Theme: artificial intelligence. Write stanza 4 (final couplet).',
            },
          ],
        },
      },
    },
    readFinalPoemTool: {
      type: 'tool',
      properties: {
        name: 'read-final-poem',
        type: 'soat',
        description: 'Read the final poem from the shared document',
        actions: ['get-document'],
        preset_parameters: { documentId: { ref: 'poemDoc' } },
      },
    },
    orchestrator: {
      type: 'agent',
      properties: {
        name: 'Sonnet Orchestrator',
        ai_provider_id: { ref: 'provider' },
        instructions:
          'Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text.',
        tool_ids: [
          { ref: 'callStanza1Tool' },
          { ref: 'callStanza2Tool' },
          { ref: 'callStanza3Tool' },
          { ref: 'callStanza4Tool' },
          { ref: 'readFinalPoemTool' },
        ],
        step_rules: [
          {
            step: 1,
            tool_choice: {
              type: 'tool',
              tool_name: 'call-stanza-1_create-agent-generation',
            },
          },
          {
            step: 2,
            tool_choice: {
              type: 'tool',
              tool_name: 'call-stanza-2_create-agent-generation',
            },
          },
          {
            step: 3,
            tool_choice: {
              type: 'tool',
              tool_name: 'call-stanza-3_create-agent-generation',
            },
          },
          {
            step: 4,
            tool_choice: {
              type: 'tool',
              tool_name: 'call-stanza-4_create-agent-generation',
            },
          },
          {
            step: 5,
            tool_choice: {
              type: 'tool',
              tool_name: 'read-final-poem_get-document',
            },
          },
        ],
        max_steps: 8,
      },
    },
  },
  outputs: {
    orchestrator_id: { ref: 'orchestrator' },
    poem_doc_id: { ref: 'poemDoc' },
  },
};
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
cat > formation.json << 'EOF'
{
  "resources": {
    "provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Sonnet Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "poemDoc": {
      "type": "document",
      "properties": {
        "content": "(empty - will be overwritten by stanza agents)",
        "path": "/poems/sonnet.txt"
      }
    },
    "poemReadTool": {
      "type": "tool",
      "properties": {
        "name": "poem-read",
        "type": "soat",
        "description": "Read the shared poem document",
        "actions": ["get-document"],
        "preset_parameters": { "documentId": { "ref": "poemDoc" } }
      }
    },
    "poemWriteTool": {
      "type": "tool",
      "properties": {
        "name": "poem-write",
        "type": "soat",
        "description": "Update the shared poem document",
        "actions": ["update-document"],
        "preset_parameters": { "documentId": { "ref": "poemDoc" } }
      }
    },
    "stanza1Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 1 - First Quatrain",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 1. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the poem title on the first line, add a blank line, then write the FIRST quatrain (4 lines) using ABAB. In poem-write, set content to the full poem-so-far including your stanza.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "stanza2Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 2 - Second Quatrain",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 2. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the SECOND quatrain (4 lines) using CDCD. In poem-write, set content to the full poem-so-far including your stanza.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "stanza3Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 3 - Third Quatrain",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 3. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the THIRD quatrain (4 lines) using EFEF. In poem-write, set content to the full poem-so-far including your stanza.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "stanza4Agent": {
      "type": "agent",
      "properties": {
        "name": "Stanza 4 - Final Couplet",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "You are deterministic stanza worker 4. Do exactly two tool calls: first poem-read, then poem-write. Never ask follow-up questions. Write the FINAL couplet (2 lines) using GG. In poem-write, set content to the full poem-so-far including your couplet.",
        "tool_ids": [{ "ref": "poemReadTool" }, { "ref": "poemWriteTool" }],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "poem-read_get-document" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "poem-write_update-document" } }
        ],
        "max_steps": 5
      }
    },
    "callStanza1Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-1",
        "type": "soat",
        "description": "Call stanza 1 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza1Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 1 with title + first quatrain." }]
        }
      }
    },
    "callStanza2Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-2",
        "type": "soat",
        "description": "Call stanza 2 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza2Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 2 (second quatrain)." }]
        }
      }
    },
    "callStanza3Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-3",
        "type": "soat",
        "description": "Call stanza 3 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza3Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 3 (third quatrain)." }]
        }
      }
    },
    "callStanza4Tool": {
      "type": "tool",
      "properties": {
        "name": "call-stanza-4",
        "type": "soat",
        "description": "Call stanza 4 agent",
        "actions": ["create-agent-generation"],
        "preset_parameters": {
          "agentId": { "ref": "stanza4Agent" },
          "messages": [{ "role": "user", "content": "Theme: artificial intelligence. Write stanza 4 (final couplet)." }]
        }
      }
    },
    "readFinalPoemTool": {
      "type": "tool",
      "properties": {
        "name": "read-final-poem",
        "type": "soat",
        "description": "Read the final poem from the shared document",
        "actions": ["get-document"],
        "preset_parameters": { "documentId": { "ref": "poemDoc" } }
      }
    },
    "orchestrator": {
      "type": "agent",
      "properties": {
        "name": "Sonnet Orchestrator",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text.",
        "tool_ids": [
          { "ref": "callStanza1Tool" },
          { "ref": "callStanza2Tool" },
          { "ref": "callStanza3Tool" },
          { "ref": "callStanza4Tool" },
          { "ref": "readFinalPoemTool" }
        ],
        "step_rules": [
          { "step": 1, "tool_choice": { "type": "tool", "tool_name": "call-stanza-1_create-agent-generation" } },
          { "step": 2, "tool_choice": { "type": "tool", "tool_name": "call-stanza-2_create-agent-generation" } },
          { "step": 3, "tool_choice": { "type": "tool", "tool_name": "call-stanza-3_create-agent-generation" } },
          { "step": 4, "tool_choice": { "type": "tool", "tool_name": "call-stanza-4_create-agent-generation" } },
          { "step": 5, "tool_choice": { "type": "tool", "tool_name": "read-final-poem_get-document" } }
        ],
        "max_steps": 8
      }
    }
  },
  "outputs": {
    "orchestrator_id": { "ref": "orchestrator" },
    "poem_doc_id": { "ref": "poemDoc" }
  }
}
EOF
TEMPLATE=$(cat formation.json)
```

</TabItem>
</Tabs>

---

## Step 4 — Validate the template

Validate the template structure before doing anything else. See [Formations](/docs/modules/formations#key-concepts) for validation rules.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat validate-formation --template "$TEMPLATE"
```

Expected output:

```json
{ "valid": true }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: validation } = await authClient.formations.validateFormation({
  body: { template },
});
console.log('Valid:', validation.valid);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/formations/validate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"template\": $TEMPLATE}" | jq '.'
```

</TabItem>
</Tabs>

---

## Step 5 — Preview the deployment plan

Preview the changes SOAT will make before deploying. The plan lists all resources that will be created. See [Formations](/docs/modules/formations#key-concepts).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat plan-formation --project_id "$PROJECT_ID" --template "$TEMPLATE" | jq '.'
```

Expected output — 14 resources all marked as `create`:

```json
[
  { "action": "create", "logical_id": "provider", "type": "ai_provider" },
  { "action": "create", "logical_id": "poemDoc", "type": "document" },
  { "action": "create", "logical_id": "poemReadTool", "type": "tool" },
  { "action": "create", "logical_id": "poemWriteTool", "type": "tool" },
  { "action": "create", "logical_id": "stanza1Agent", "type": "agent" },
  { "action": "create", "logical_id": "stanza2Agent", "type": "agent" },
  { "action": "create", "logical_id": "stanza3Agent", "type": "agent" },
  { "action": "create", "logical_id": "stanza4Agent", "type": "agent" },
  { "action": "create", "logical_id": "callStanza1Tool", "type": "tool" },
  { "action": "create", "logical_id": "callStanza2Tool", "type": "tool" },
  { "action": "create", "logical_id": "callStanza3Tool", "type": "tool" },
  { "action": "create", "logical_id": "callStanza4Tool", "type": "tool" },
  {
    "action": "create",
    "logical_id": "readFinalPoemTool",
    "type": "tool"
  },
  { "action": "create", "logical_id": "orchestrator", "type": "agent" }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: plan } = await authClient.formations.planFormation({
  body: { project_id: PROJECT_ID, template },
});
for (const change of plan) {
  console.log(
    `${change.action.padEnd(8)} ${change.logical_id} (${change.type})`
  );
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/formations/plan" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"template\": $TEMPLATE}" | jq '.'
```

</TabItem>
</Tabs>

---

## Step 6 — Deploy the formation

Create the formation. SOAT provisions all 14 resources in dependency order and resolves every `ref` expression. The `outputs` section surfaces the orchestrator ID and poem document ID so you don't need to track them manually. See [Formations](/docs/modules/formations#key-concepts).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FORMATION=$(soat create-formation \
  --project_id "$PROJECT_ID" \
  --name "sonnet-workshop" \
  --template "$TEMPLATE")

FORMATION_ID=$(printf '%s' "$FORMATION" | jq -r '.id')
ORCHESTRATOR_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.orchestrator_id')
POEM_DOC_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.poem_doc_id')

echo "FORMATION_ID:    $FORMATION_ID"
echo "ORCHESTRATOR_ID: $ORCHESTRATOR_ID"
echo "POEM_DOC_ID:     $POEM_DOC_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: formation } = await authClient.formations.createFormation({
  body: {
    project_id: PROJECT_ID,
    name: 'sonnet-workshop',
    template,
  },
});
const FORMATION_ID = formation.id;
const ORCHESTRATOR_ID = formation.outputs?.orchestrator_id as string;
const POEM_DOC_ID = formation.outputs?.poem_doc_id as string;

console.log('Formation:', FORMATION_ID);
console.log('Orchestrator:', ORCHESTRATOR_ID);
console.log('Poem doc:', POEM_DOC_ID);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FORMATION=$(curl -s -X POST "$SOAT_URL/api/v1/formations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"name\": \"sonnet-workshop\", \"template\": $TEMPLATE}")

FORMATION_ID=$(printf '%s' "$FORMATION" | jq -r '.id')
ORCHESTRATOR_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.orchestrator_id')
POEM_DOC_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.poem_doc_id')

echo "FORMATION_ID:    $FORMATION_ID"
echo "ORCHESTRATOR_ID: $ORCHESTRATOR_ID"
echo "POEM_DOC_ID:     $POEM_DOC_ID"
```

</TabItem>
</Tabs>

The formation object includes a `resources` map keyed by logical ID, each with its physical resource ID. You can inspect the full resource manifest:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-formation --formation_id "$FORMATION_ID" | jq '{id, name, status, outputs}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: f } = await authClient.formations.getFormation({
  path: { formation_id: FORMATION_ID },
});
console.log(
  JSON.stringify(
    { id: f.id, name: f.name, status: f.status, outputs: f.outputs },
    null,
    2
  )
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, name, status, outputs}'
```

</TabItem>
</Tabs>

---

## Step 7 — Run the orchestrator

Trigger the orchestrator agent to run the full sonnet pipeline. The orchestrator calls each stanza agent in order via its fixed tools. See [Agents — Generation](/docs/modules/agents#generation).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RESULT=$(soat create-agent-generation \
  --agent-id "$ORCHESTRATOR_ID" \
  --messages '[{"role":"user","content":"Write a sonnet about the theme: artificial intelligence"}]')

printf '%s\n' "$RESULT" | jq '{status, trace_id}'
TRACE_ID=$(printf '%s\n' "$RESULT" | jq -r '.trace_id')
```

Expected output:

```json
{
  "status": "completed",
  "trace_id": "trace_xxxxxxxxxxxx"
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await authClient.agents.createAgentGeneration({
  path: { agent_id: ORCHESTRATOR_ID },
  body: {
    messages: [
      {
        role: 'user',
        content: 'Write a sonnet about the theme: artificial intelligence',
      },
    ],
  },
});
const TRACE_ID = generation.trace_id;
console.log('Status:', generation.status);
console.log('Trace:', TRACE_ID);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RESULT=$(curl -s -X POST "$SOAT_URL/api/v1/agents/$ORCHESTRATOR_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a sonnet about the theme: artificial intelligence"}]}')

printf '%s\n' "$RESULT" | jq '{status, trace_id}'
TRACE_ID=$(printf '%s\n' "$RESULT" | jq -r '.trace_id')
```

</TabItem>
</Tabs>

---

## Step 8 — Read the poem document

The stanza agents accumulated the sonnet in the shared poem document. Read it directly from the [Documents](/docs/modules/documents#examples) store.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-document --document-id "$POEM_DOC_ID" | jq -r '.content'
```

Expected output — a complete Shakespearean sonnet:

```
Silicon Dreams

In circuits bright where human thought takes form,
A mind emerges from the data's flow,
It learns through storms and weathers every storm,
And seeds of knowledge in its memory grow.

With second quatrain lines that build and rise,
Each layer deep connects what came before,
It reads the world through countless digital eyes,
And writes new knowledge, always seeking more.

Now in the third quatrain, patterns found
In vast arrays of numbers, text and light,
The third quatrain concludes with solid ground,
Where artificial minds approach their height.

And in this final couplet two lines close,
Where silicon and thought in union flows.
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: doc } = await authClient.documents.getDocument({
  path: { document_id: POEM_DOC_ID },
});
console.log(doc.content);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/documents/$POEM_DOC_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.content'
```

</TabItem>
</Tabs>

---

## Step 9 — Inspect the trace tree

The `/tree` endpoint returns the full execution tree rooted at the orchestrator trace. Each node is a [trace](/docs/modules/traces#examples) record, and its `children` array contains the traces spawned by sub-agent tool calls.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-trace-tree --trace-id "$TRACE_ID" | jq '{id, step_count, children_count: (.children | length)}'
```

Expected output — the orchestrator at the root with 4 stanza workers as children:

```json
{
  "id": "trace_xxxxxxxxxxxx",
  "step_count": 5,
  "children_count": 4
}
```

List all traces for the project to see every agent that ran:

```bash
soat list-traces --project-id "$PROJECT_ID" | jq '.data[] | {id, agent_id, step_count, parent_trace_id}'
```

The orchestrator trace has `parent_trace_id: null`; each stanza worker trace references the orchestrator's trace ID as its parent.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: tree } = await authClient.traces.getTraceTree({
  path: { trace_id: TRACE_ID },
});
console.log('Orchestrator steps:', tree.step_count);
console.log('Nested agent traces:', tree.children?.length ?? 0);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/traces/$TRACE_ID/tree" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, step_count, children_count: (.children | length)}'
```

</TabItem>
</Tabs>

---

## Step 10 — Update the formation

Update the formation by supplying a modified template. SOAT diffs the new template against the current state and applies only the required changes. Here we update the orchestrator's instructions to change the sonnet theme prompt. See [Formations](/docs/modules/formations#key-concepts).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
UPDATED_TEMPLATE=$(printf '%s' "$TEMPLATE" | jq \
  '.resources.orchestrator.properties.instructions = "Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text. Focus on vivid imagery."')

soat update-formation \
  --formation_id "$FORMATION_ID" \
  --template "$UPDATED_TEMPLATE" | jq '{id, status}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const updatedTemplate = JSON.parse(JSON.stringify(template));
updatedTemplate.resources.orchestrator.properties.instructions =
  'Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text. Focus on vivid imagery.';

const { data: updated } = await authClient.formations.updateFormation({
  path: { formation_id: FORMATION_ID },
  body: { template: updatedTemplate },
});
console.log('Status:', updated.status);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
UPDATED_TEMPLATE=$(printf '%s' "$TEMPLATE" | jq \
  '.resources.orchestrator.properties.instructions = "Call tools in this exact order: call-stanza-1, call-stanza-2, call-stanza-3, call-stanza-4, then read-final-poem. Do not ask follow-up questions. Return ONLY the poem text. Focus on vivid imagery."')

curl -s -X PUT "$SOAT_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"template\": $UPDATED_TEMPLATE}" | jq '{id, status}'
```

</TabItem>
</Tabs>

---

## Step 11 — View operation events

Each formation deployment and update appends events to the formation's event log. Use this to audit exactly which resources were created, updated, or deleted and in what order. See [Formations](/docs/modules/formations#key-concepts).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-formation-events --formation_id "$FORMATION_ID" | jq '.[] | {operation_type, status}'
```

Expected output — one entry per deployment operation:

```json
{ "operation_type": "create", "status": "succeeded" }
{ "operation_type": "update", "status": "succeeded" }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: events } = await authClient.formations.listFormationEvents({
  path: { formation_id: FORMATION_ID },
});
for (const op of events ?? []) {
  console.log(`${op.operation_type} — ${op.status}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/formations/$FORMATION_ID/events" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.[] | {operation_type, status}'
```

</TabItem>
</Tabs>

---

## Step 12 — Delete the formation

Deleting a formation tries to remove managed resources in reverse dependency order. Depending on runtime artifacts created by the formation flow (for example, traces or generations that keep references alive), the delete operation may return `success: false` and keep the formation in `delete_failed` status for inspection. See [Formations](/docs/modules/formations#key-concepts).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DELETE_RESULT=$(soat delete-formation --formation_id "$FORMATION_ID")
printf '%s\n' "$DELETE_RESULT" | jq '.'

# Always inspect the current formation state after delete. When deletion
# succeeds this prints an error payload; when it fails it prints id/status.
soat get-formation --formation_id "$FORMATION_ID" | jq '{id, status, error}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: deletion } = await authClient.formations.deleteFormation({
  path: { formation_id: FORMATION_ID },
});
console.log('delete success:', deletion?.success);

if (deletion?.success) {
  // Confirm it's gone (should throw 404)
  try {
    await authClient.formations.getFormation({
      path: { formation_id: FORMATION_ID },
    });
  } catch {
    console.log('Formation deleted — 404 as expected');
  }
} else {
  // Keep it for inspection when delete_failed happens.
  const { data: remaining } = await authClient.formations.getFormation({
    path: { formation_id: FORMATION_ID },
  });
  console.log('Formation delete failed, current status:', remaining?.status);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DELETE_RESPONSE=$(curl -s -X DELETE "$SOAT_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
printf '%s\n' "$DELETE_RESPONSE" | jq '.'

# Always inspect the current formation state after delete. When deletion
# succeeds this prints an error payload; when it fails it prints id/status.
curl -s "$SOAT_URL/api/v1/formations/$FORMATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, status, error}'
```

</TabItem>
</Tabs>

---

## How It Works — Formation Dependency Resolution

The dependency graph for the sonnet formation is resolved in five waves:

```
Wave 1 (no deps):       provider       poemDoc
                           │               │
Wave 2 (depend on Wave 1): └──poemReadTool─┘  poemWriteTool
                                   │               │
Wave 3 (depend on Wave 2):  stanza1Agent  stanza2Agent  stanza3Agent  stanza4Agent
                                │               │               │               │
Wave 4 (depend on Wave 3): callStanza1  callStanza2  callStanza3  callStanza4   │
                                │               │               │               │
                            readFinalPoemTool (depends on poemDoc, from Wave 1) │
                                │                                               │
Wave 5 (depend on Waves 4+1):                orchestrator
```

Without formations, reproducing this pipeline requires **14 ordered API calls**, manual ID tracking between each, and a custom script to encode the dependencies. With formations, you write the template once and SOAT handles the rest — including updates (diff) and teardown (reverse order).

---

## Summary

In this tutorial you deployed the same multi-agent sonnet pipeline as [Multi-Agent Sonnet with Nested Agent Calls](/docs/tutorials/multi-agent-orchestration), but collapsed all resource creation into a single declarative template.

| Concept                           | What you did                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Formation template                | Wrote a single JSON template describing all 14 resources                             |
| `{ "ref": ... }` cross-references | Wired `ai_provider_id`, `tool_ids`, and `preset_parameters.agentId` across resources |
| Validate and plan                 | Checked the template structure and previewed 14 `create` actions before deploying    |
| Deploy                            | Created all 14 resources in dependency order with one API call                       |
| Outputs                           | Retrieved `ORCHESTRATOR_ID` and `POEM_DOC_ID` directly from the formation outputs    |
| Run the orchestrator              | Triggered the same multi-agent sonnet pipeline with a single generation call         |
| Trace tree                        | Inspected the full nested execution across the orchestrator and four stanza workers  |
| Update                            | Changed the orchestrator instructions; SOAT applied only the `update` diff           |
| Delete                            | Removed all 14 resources in reverse dependency order with one call                   |
