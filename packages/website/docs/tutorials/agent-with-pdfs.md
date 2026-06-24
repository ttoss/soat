---
sidebar_position: 9
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent over a Library of PDFs

This tutorial builds an agent that answers questions from a small library of PDF
manuals. You upload PDFs, ingest them into chunked, embedded
[Documents](/docs/modules/documents#examples), scope an
[agent](/docs/modules/agents#examples) to them with `knowledge_config`, and watch
the agent answer from the right page — with no RAG logic in the prompt.

It maps directly onto the build plan:

| Plan step | Where in this tutorial |
| --------- | ---------------------- |
| **A. Ingest the PDFs** (organize with a path prefix) | Steps 5–7 |
| **B. Create the agent** scoped with `knowledge_config` | Step 9 |
| **C. Retrieval** — automatic and agent-driven | Steps 10–11 |
| **D. Citations** — `page` + `document_id` per result | Step 8 |

:::note Requires native file ingestion
`POST /api/v1/documents/ingest` and the `DocumentChunk` model land in
[#245](https://github.com/ttoss/soat/pull/245). Run this tutorial against a server
that includes that change.
:::

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` pulled. The PDFs
  here are deliberately tiny (a few short facts each) so a small local model can
  answer reliably from the injected context.

---

## Step 1 — Log in as admin

Admin is the built-in superuser. It bypasses policy evaluation. See
[Users](/docs/modules/users#examples) for authentication details.

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
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
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
PROJECT_ID=$(soat create-project --name "Manuals Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Manuals Demo' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Manuals Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an AI provider

A local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama, so the
tutorial runs without external credentials. To use xAI, OpenAI, Anthropic, or
Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: aiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});
const AI_PROVIDER_ID = aiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Prepare two small PDFs

These two base64 strings are real, single-page PDFs with a text layer that `unpdf`
(the server's parser) extracts cleanly. Each holds a handful of short facts:

- **printer-x1000.pdf** — "The paper tray holds 250 sheets.", standby timeout 5 minutes, toner every 8000 pages.
- **router-r200.pdf** — "The default admin password is admin1234.", up to 32 devices, 10-second reset.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PRINTER_PDF_B64="JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMjA4ID4+CnN0cmVhbQpCVCAvRjEgMTYgVGYgNzIgNzIwIFRkIDIwIFRMCihYMTAwMCBQcmludGVyIFF1aWNrIEd1aWRlKSBUagpUKiAoVGhlIHBhcGVyIHRyYXkgaG9sZHMgMjUwIHNoZWV0cy4pIFRqClQqIChUaGUgZGVmYXVsdCBzdGFuZGJ5IHRpbWVvdXQgaXMgNSBtaW51dGVzLikgVGoKVCogKFJlcGxhY2UgdGhlIHRvbmVyIGNhcnRyaWRnZSBldmVyeSA4MDAwIHBhZ2VzLikgVGoKRVQKCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo1NzAKJSVFT0Y="

ROUTER_PDF_B64="JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMjI5ID4+CnN0cmVhbQpCVCAvRjEgMTYgVGYgNzIgNzIwIFRkIDIwIFRMCihSMjAwIFJvdXRlciBTZXR1cCBHdWlkZSkgVGoKVCogKFRoZSBkZWZhdWx0IGFkbWluIHBhc3N3b3JkIGlzIGFkbWluMTIzNC4pIFRqClQqIChUaGUgcm91dGVyIHN1cHBvcnRzIHVwIHRvIDMyIGNvbm5lY3RlZCBkZXZpY2VzLikgVGoKVCogKEhvbGQgdGhlIHJlc2V0IGJ1dHRvbiBmb3IgMTAgc2Vjb25kcyB0byBmYWN0b3J5IHJlc2V0LikgVGoKRVQKCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo1OTEKJSVFT0Y="
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Same base64 strings as the CLI tab.
const PRINTER_PDF_B64 = 'JVBERi0xLjQK...'; // printer-x1000.pdf (truncated)
const ROUTER_PDF_B64 = 'JVBERi0xLjQK...'; // router-r200.pdf (truncated)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Same base64 strings as the CLI tab.
PRINTER_PDF_B64="JVBERi0xLjQK..." # printer-x1000.pdf (truncated)
ROUTER_PDF_B64="JVBERi0xLjQK..."  # router-r200.pdf (truncated)
```

</TabItem>
</Tabs>

---

## Step 5 — Upload the PDFs

Upload each PDF as a [File](/docs/modules/files#examples). Set `content_type` to
`application/pdf` — ingestion dispatches on it in the next step.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PRINTER_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "printer-x1000.pdf" \
  --content-type "application/pdf" \
  --content "$PRINTER_PDF_B64" | jq -r '.id')
echo "PRINTER_FILE_ID: $PRINTER_FILE_ID"

ROUTER_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "router-r200.pdf" \
  --content-type "application/pdf" \
  --content "$ROUTER_PDF_B64" | jq -r '.id')
echo "ROUTER_FILE_ID: $ROUTER_FILE_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: printerFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'printer-x1000.pdf',
    content_type: 'application/pdf',
    content: PRINTER_PDF_B64,
  },
});
const PRINTER_FILE_ID = printerFile.id;

const { data: routerFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'router-r200.pdf',
    content_type: 'application/pdf',
    content: ROUTER_PDF_B64,
  },
});
const ROUTER_FILE_ID = routerFile.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PRINTER_FILE_ID=$(curl -s -X POST "$SOAT_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"printer-x1000.pdf\",\"content_type\":\"application/pdf\",\"content\":\"$PRINTER_PDF_B64\"}" \
  | jq -r '.id')
echo "PRINTER_FILE_ID: $PRINTER_FILE_ID"

ROUTER_FILE_ID=$(curl -s -X POST "$SOAT_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"router-r200.pdf\",\"content_type\":\"application/pdf\",\"content\":\"$ROUTER_PDF_B64\"}" \
  | jq -r '.id')
echo "ROUTER_FILE_ID: $ROUTER_FILE_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Ingest the PDFs (Plan A)

`POST /documents/ingest` extracts the text page-by-page, splits it into chunks, embeds
each chunk, and stores **one Document with many `DocumentChunk` rows**. The
`--path-prefix` organizes the documents under a common path so you can scope an agent
to the whole subtree later with a single `document_paths` prefix.

Ingestion is **asynchronous by default**: the endpoint returns `202 Accepted` with
`status: pending` and processing runs in the background (see
[Documents — Async File Ingestion](/docs/modules/documents#async-file-ingestion)). Here
we pass `--async false` so the call blocks until the document is `ready` and the
response carries the final `chunk_count` — that way the next steps can search the
chunks immediately without polling.

The default `page` chunk strategy produces **one chunk per page** — these PDFs are one
page each, so `chunk_count` is `1`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$PRINTER_FILE_ID" \
  --path-prefix "/manuals/" \
  --async false | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 1 }

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$ROUTER_FILE_ID" \
  --path-prefix "/manuals/" \
  --async false | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 1 }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: printerDoc } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: {
    project_id: PROJECT_ID,
    file_id: PRINTER_FILE_ID,
    path_prefix: '/manuals/',
  },
});
console.log(printerDoc.status, printerDoc.chunk_count); // "ready" 1

const { data: routerDoc } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: {
    project_id: PROJECT_ID,
    file_id: ROUTER_FILE_ID,
    path_prefix: '/manuals/',
  },
});
console.log(routerDoc.status, routerDoc.chunk_count); // "ready" 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/documents/ingest?async=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$PRINTER_FILE_ID\",\"path_prefix\":\"/manuals/\"}" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'

curl -s -X POST "$SOAT_URL/api/v1/documents/ingest?async=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$ROUTER_FILE_ID\",\"path_prefix\":\"/manuals/\"}" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

---

## Step 7 — Finer chunks with the `size` strategy (Plan A, optional)

For dense, long-page PDFs, one chunk per page is too coarse — a whole page becomes a
single embedding and retrieval gets fuzzy. The `size` strategy splits the extracted
text into fixed-size character windows (`chunk_size` / `chunk_overlap`) for sharper
retrieval. The trade-off: `size` chunks are not page-aligned, so they carry no `page`
number for citations.

Re-ingest the printer PDF into a separate path with small windows to see multiple
chunks from the same one-page file:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$PRINTER_FILE_ID" \
  --path-prefix "/manuals-size/" \
  --chunk-strategy "size" \
  --chunk-size 60 \
  --chunk-overlap 10 \
  --async false | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 3 }   # multiple windows from one page
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sized } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: {
    project_id: PROJECT_ID,
    file_id: PRINTER_FILE_ID,
    path_prefix: '/manuals-size/',
    chunk_strategy: 'size',
    chunk_size: 60,
    chunk_overlap: 10,
  },
});
console.log(sized.status, sized.chunk_count); // "ready" > 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/documents/ingest?async=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$PRINTER_FILE_ID\",\"path_prefix\":\"/manuals-size/\",\"chunk_strategy\":\"size\",\"chunk_size\":60,\"chunk_overlap\":10}" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

Start with `page` (citations, simpler) and only switch to `size` if recall is poor on
dense documents.

---

## Step 8 — Search the knowledge layer directly (Plan D)

Before wiring an agent, query the knowledge layer to see retrieval and **citations**.
Search runs at the **chunk** level, so each result carries `document_id`, `chunk_id`,
and (for `page`-chunked docs) the `page` number. Scope the search to `/manuals/` with
`document_paths`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "How many sheets does the paper tray hold?" \
  --document-paths '["/manuals/"]' \
  --limit 3 \
  | jq '[.results[] | {document_id, chunk_id, page, score, content}]'
```

The top hit is the printer chunk, attributable to its page:

```json
[
  {
    "document_id": "doc_...",
    "chunk_id": "dchunk_...",
    "page": 1,
    "score": 0.78,
    "content": "X1000 Printer Quick Guide\nThe paper tray holds 250 sheets. ..."
  }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: search } = await adminSoat.knowledge.searchKnowledge({
  body: {
    project_id: PROJECT_ID,
    query: 'How many sheets does the paper tray hold?',
    document_paths: ['/manuals/'],
    limit: 3,
  },
});
for (const r of search.results) {
  console.log(r.document_id, r.chunk_id, r.page, r.score);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"How many sheets does the paper tray hold?\",\"document_paths\":[\"/manuals/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, chunk_id, page, score, content}]'
```

</TabItem>
</Tabs>

Those `document_id` + `page` fields are what let an agent cite "per `printer-x1000.pdf`,
page 1…".

---

## Step 9 — Create the agent scoped to the PDFs (Plan B)

The `knowledge_config` field tells SOAT to search the manuals before every generation,
using the last user message as the query — no RAG logic in the prompt. Scope it to the
`/manuals/` subtree and bound results with `min_score` and `limit`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Manuals Agent" \
  --instructions "You are a product support assistant. Answer using only the provided knowledge context. Be concise and cite the document and page when possible." \
  --knowledge-config '{"document_paths":["/manuals/"],"min_score":0.5,"limit":8}' \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Manuals Agent',
    instructions:
      'You are a product support assistant. Answer using only the provided knowledge context. Be concise and cite the document and page when possible.',
    knowledge_config: {
      document_paths: ['/manuals/'],
      min_score: 0.5,
      limit: 8,
    },
  },
});
const AGENT_ID = agent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Manuals Agent\",\"instructions\":\"You are a product support assistant. Answer using only the provided knowledge context. Be concise and cite the document and page when possible.\",\"knowledge_config\":{\"document_paths\":[\"/manuals/\"],\"min_score\":0.5,\"limit\":8}}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 10 — Automatic retrieval (Plan C)

Ask a question that is answered only inside a PDF. SOAT embeds the user message,
searches `/manuals/`, and injects the top chunks as a `system` message before the model
runs. The agent never sees a "tool call" — the context is just there.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"What is the default admin password for the R200 router?"}]' \
  | jq '{status: .status, output: .output.content}'
```

Expected shape (exact wording varies by model):

```json
{
  "status": "completed",
  "output": "The default admin password for the R200 router is admin1234."
}
```

The answer (`admin1234`) appears only in `router-r200.pdf` — it was retrieved and
injected automatically.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  body: {
    messages: [
      {
        role: 'user',
        content: 'What is the default admin password for the R200 router?',
      },
    ],
  },
});
console.log(generation.status); // "completed"
console.log(generation.output.content); // "...admin1234..."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the default admin password for the R200 router?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

---

## Step 11 — Agent-driven retrieval (Plan C)

Automatic retrieval uses the raw user message as the query. Sometimes you want a
**reformulated** query — the building block is the same `search-knowledge` operation,
called explicitly with a sharpened query. This is exactly what an agent does when it
decides, mid-reasoning, that it needs to look something up.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "printer paper tray capacity sheets" \
  --document-paths '["/manuals/"]' \
  --limit 1 \
  | jq '.results[0] | {document_id, page, content}'
# → the X1000 chunk: "...The paper tray holds 250 sheets..."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: refined } = await adminSoat.knowledge.searchKnowledge({
  body: {
    project_id: PROJECT_ID,
    query: 'printer paper tray capacity sheets',
    document_paths: ['/manuals/'],
    limit: 1,
  },
});
console.log(refined.results[0].content); // "...250 sheets..."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"printer paper tray capacity sheets\",\"document_paths\":[\"/manuals/\"],\"limit\":1}" \
  | jq '.results[0] | {document_id, page, content}'
```

</TabItem>
</Tabs>

Use automatic retrieval (Step 10) for single-shot Q&A and agent-driven retrieval when a
question needs the agent to break it down and search in its own words.

---

## What you built

- **A. Ingested** two PDFs into chunked, embedded Documents under `/manuals/`, with a
  choice of `page` (citations) or `size` (sharper recall) chunking.
- **B. Scoped** an agent to that subtree with one `knowledge_config` prefix.
- **C. Retrieved** both ways — automatic injection and an explicit, reformulated
  `search-knowledge` query.
- **D. Cited** answers down to `document_id` + `page`.

To grow the library, upload more PDFs and ingest them under the same `/manuals/` prefix
— the agent picks them up automatically with no config change. For organizing larger
sets, ingest under nested prefixes (e.g. `/manuals/network/`, `/manuals/print/`) and
point different agents at different subtrees.
