---
description: "Build a SOAT agent that answers questions from a library of PDFs using ingestion and knowledge search."
keywords:
  - RAG tutorial
  - PDF question answering
  - document ingestion
  - knowledge search
  - vector search
  - retrieval augmented generation
sidebar_position: 8
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent over a Library of PDFs

Upload PDFs, ingest them into chunked, embedded
[Documents](/docs/modules/documents#examples), scope an
[agent](/docs/modules/agents#examples) to them with `knowledge_config`, and get
answers from the right page with no RAG logic in the prompt.

| Plan step | Where in this tutorial |
| --------- | ---------------------- |
| **A. Ingest the PDFs** (organize with a path prefix) | Steps 5–7 |
| **B. Create the agent** scoped with `knowledge_config` | Step 9 |
| **C. Retrieval** — automatic, agent-driven via API, and agent-driven via tool | Steps 10–12 |
| **D. Citations** — `page` + `document_id` per result | Step 8 |

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts).
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.
- [Ollama](https://ollama.com) with `qwen2.5:0.5b` pulled. The PDFs are tiny so a
  small model answers reliably from the injected context.

---

## Step 1 — Log in as admin

See [Users](/docs/modules/users#examples) for authentication.

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

A local Ollama [AI provider](/docs/modules/ai-providers#examples). For other
providers see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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

Two base64 single-page PDFs with a text layer `unpdf` (the server's parser)
extracts. Their facts:

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

Upload each PDF as a [File](/docs/modules/files#examples) with `content_type`
`application/pdf`; ingestion dispatches on it.

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

[`POST /documents/ingest`](/docs/api/documents/ingest-document) extracts text
page-by-page, chunks and embeds it, and stores one Document with many
`DocumentChunk` rows. `--path-prefix` puts the documents under a common path so an
agent can be scoped to the subtree with one `document_paths` prefix.

Ingestion is asynchronous
([Documents — Async File Ingestion](/docs/modules/documents#async-file-ingestion));
`--wait true` blocks until the document is `ready`. `chunk_count` comes from
[`GET /documents/:id/status`](/docs/modules/documents#polling-ingestion-status). The
default `page` strategy yields one chunk per page, so `chunk_count` is `1` here.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PRINTER_DOC_ID=$(soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$PRINTER_FILE_ID" \
  --path-prefix "/manuals/" \
  --wait true | jq -r '.id')
soat get-document-status --document-id "$PRINTER_DOC_ID" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 1 }

ROUTER_DOC_ID=$(soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$ROUTER_FILE_ID" \
  --path-prefix "/manuals/" \
  --wait true | jq -r '.id')
soat get-document-status --document-id "$ROUTER_DOC_ID" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 1 }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: printerDoc } = await adminSoat.documents.ingestDocument({
  query: { wait: true },
  body: {
    project_id: PROJECT_ID,
    file_id: PRINTER_FILE_ID,
    path_prefix: '/manuals/',
  },
});
const { data: printerStatus } = await adminSoat.documents.getDocumentStatus({
  path: { document_id: printerDoc.id },
});
console.log(printerStatus.status, printerStatus.chunk_count); // "ready" 1

const { data: routerDoc } = await adminSoat.documents.ingestDocument({
  query: { wait: true },
  body: {
    project_id: PROJECT_ID,
    file_id: ROUTER_FILE_ID,
    path_prefix: '/manuals/',
  },
});
const { data: routerStatus } = await adminSoat.documents.getDocumentStatus({
  path: { document_id: routerDoc.id },
});
console.log(routerStatus.status, routerStatus.chunk_count); // "ready" 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PRINTER_DOC_ID=$(curl -s -X POST "$SOAT_URL/api/v1/documents/ingest?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$PRINTER_FILE_ID\",\"path_prefix\":\"/manuals/\"}" \
  | jq -r '.id')
curl -s "$SOAT_URL/api/v1/documents/$PRINTER_DOC_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'

ROUTER_DOC_ID=$(curl -s -X POST "$SOAT_URL/api/v1/documents/ingest?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$ROUTER_FILE_ID\",\"path_prefix\":\"/manuals/\"}" \
  | jq -r '.id')
curl -s "$SOAT_URL/api/v1/documents/$ROUTER_DOC_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

---

## Step 7 — Finer chunks with the `size` strategy (Plan A, optional)

The `size` strategy splits extracted text into fixed-size character windows
(`chunk_size` / `chunk_overlap`) for sharper retrieval on dense pages. `size` chunks
are not page-aligned and carry no `page` number.

A [file backs only one Document](/docs/modules/documents#file-ingestion-and-chunking):
re-ingesting `$PRINTER_FILE_ID` returns `409 FILE_ALREADY_INGESTED`. Upload a second
copy of the bytes and ingest that file with small windows:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PRINTER_FILE_ID_SIZE=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "printer-x1000.pdf" \
  --content-type "application/pdf" \
  --content "$PRINTER_PDF_B64" | jq -r '.id')

SIZED_DOC_ID=$(soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$PRINTER_FILE_ID_SIZE" \
  --path-prefix "/manuals-size/" \
  --chunk-strategy "size" \
  --chunk-size 60 \
  --chunk-overlap 10 \
  --wait true | jq -r '.id')
soat get-document-status --document-id "$SIZED_DOC_ID" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 3 }   # multiple windows from one page
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: printerFileSize } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'printer-x1000.pdf',
    content_type: 'application/pdf',
    content: PRINTER_PDF_B64,
  },
});

const { data: sized } = await adminSoat.documents.ingestDocument({
  query: { wait: true },
  body: {
    project_id: PROJECT_ID,
    file_id: printerFileSize.id,
    path_prefix: '/manuals-size/',
    chunk_strategy: 'size',
    chunk_size: 60,
    chunk_overlap: 10,
  },
});
const { data: sizedStatus } = await adminSoat.documents.getDocumentStatus({
  path: { document_id: sized.id },
});
console.log(sizedStatus.status, sizedStatus.chunk_count); // "ready" > 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PRINTER_FILE_ID_SIZE=$(curl -s -X POST "$SOAT_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"printer-x1000.pdf\",\"content_type\":\"application/pdf\",\"content\":\"$PRINTER_PDF_B64\"}" \
  | jq -r '.id')

SIZED_DOC_ID=$(curl -s -X POST "$SOAT_URL/api/v1/documents/ingest?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$PRINTER_FILE_ID_SIZE\",\"path_prefix\":\"/manuals-size/\",\"chunk_strategy\":\"size\",\"chunk_size\":60,\"chunk_overlap\":10}" \
  | jq -r '.id')
curl -s "$SOAT_URL/api/v1/documents/$SIZED_DOC_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

Prefer `page` (citations); switch to `size` when recall is poor on dense documents.

---

## Step 8 — Search the knowledge layer directly (Plan D)

Search runs at the chunk level: each result carries `document_id`, `chunk_id` and,
for `page`-chunked docs, `page`. Scope to `/manuals/` with `document_paths`. See
[Knowledge](/docs/modules/knowledge).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "How many sheets does the paper tray hold?" \
  --document-paths '["/manuals/"]' \
  --limit 3 \
  | jq '[.results[] | {document_id, chunk_id, page, similarity_score, content}]'
```

The top hit is the printer chunk:

```json
[
  {
    "document_id": "doc_...",
    "chunk_id": "dchunk_...",
    "page": 1,
    "similarity_score": 0.78,
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
  console.log(r.document_id, r.chunk_id, r.page, r.similarity_score);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"How many sheets does the paper tray hold?\",\"document_paths\":[\"/manuals/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, chunk_id, page, similarity_score, content}]'
```

</TabItem>
</Tabs>

`document_id` + `page` let an agent cite "per `printer-x1000.pdf`, page 1".

---

## Step 9 — Create the agent scoped to the PDFs (Plan B)

`knowledge_config` searches the manuals before every generation with the last user
message as the query. Scope to `/manuals/`; bound results with `min_score` and `limit`.
See [Agents](/docs/modules/agents#examples).

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

SOAT embeds the user message, searches `/manuals/`, and injects the top chunks as a
`system` message before the model runs ([Agents](/docs/modules/agents#examples)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
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

`admin1234` appears only in `router-r200.pdf`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  query: { wait: true },
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
curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the default admin password for the R200 router?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

---

## Step 11 — Agent-driven retrieval (Plan C)

For a reformulated query, call the same `search-knowledge` operation explicitly
([Knowledge](/docs/modules/knowledge)); this is what an agent does when it decides to
look something up.

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

Automatic retrieval suits single-shot Q&A; agent-driven retrieval suits questions the
agent must break down.

---

## Step 12 — Give the agent a knowledge tool (Plan D)

Wrap the operation as a [`builtin` tool](/docs/modules/tools#builtin) so the model
decides when to search and what to ask. `preset_parameters` pins the project and the
`/manuals/` subtree, hidden from the model; only `query` (and optionally `limit`) remain.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
KNOWLEDGE_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "manuals" \
  --type builtin \
  --description "Searches the ingested product manuals for relevant passages" \
  --actions '["search-knowledge"]' \
  --preset-parameters '{"project_id": "'"$PROJECT_ID"'", "document_paths": ["/manuals/"]}' \
  | jq -r '.id')
echo "KNOWLEDGE_TOOL_ID: $KNOWLEDGE_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: knowledgeTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'manuals',
    type: 'soat',
    description: 'Searches the ingested product manuals for relevant passages',
    actions: ['search-knowledge'],
    preset_parameters: { projectId: PROJECT_ID, documentPaths: ['/manuals/'] },
  },
});
const KNOWLEDGE_TOOL_ID = knowledgeTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
KNOWLEDGE_TOOL_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"manuals\",\"type\":\"soat\",\"description\":\"Searches the ingested product manuals for relevant passages\",\"actions\":[\"search-knowledge\"],\"preset_parameters\":{\"projectId\":\"$PROJECT_ID\",\"documentPaths\":[\"/manuals/\"]}}" \
  | jq -r '.id')
echo "KNOWLEDGE_TOOL_ID: $KNOWLEDGE_TOOL_ID"
```

</TabItem>
</Tabs>

Attach it to a new [agent](/docs/modules/agents#examples) without `knowledge_config`,
so the tool is the only path to the manuals. The model sees it as
`manuals_search-knowledge` ([Tool Name Resolution](/docs/modules/tools#tool-name-resolution)):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TOOL_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Manuals Agent (Tool-Driven)" \
  --instructions "You are a product support assistant. Always call the manuals_search-knowledge tool with a short search query before answering a product question. Be concise and cite the document and page when possible." \
  --tool-bindings '[{"tool_id": "'"$KNOWLEDGE_TOOL_ID"'"}]' \
  | jq -r '.id')
echo "TOOL_AGENT_ID: $TOOL_AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: toolAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Manuals Agent (Tool-Driven)',
    instructions:
      'You are a product support assistant. Always call the manuals_search-knowledge tool with a short search query before answering a product question. Be concise and cite the document and page when possible.',
    tool_bindings: [{ tool_id: KNOWLEDGE_TOOL_ID }],
  },
});
const TOOL_AGENT_ID = toolAgent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TOOL_AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Manuals Agent (Tool-Driven)\",\"instructions\":\"You are a product support assistant. Always call the manuals_search-knowledge tool with a short search query before answering a product question. Be concise and cite the document and page when possible.\",\"tool_bindings\":[{ \"tool_id\": \"$KNOWLEDGE_TOOL_ID\" }]}" \
  | jq -r '.id')
echo "TOOL_AGENT_ID: $TOOL_AGENT_ID"
```

</TabItem>
</Tabs>

The model calls `manuals_search-knowledge`, the server executes it in-process, and
the response comes back `completed`; `builtin` tools run server-side, unlike `client`
tools, which pause with `requires_action`:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id "$TOOL_AGENT_ID" \
  --messages '[{"role":"user","content":"How many devices can the R200 router support?"}]' \
  | jq '{status: .status, output: .output.content}'
```

Expected shape (exact wording varies by model):

```json
{
  "status": "completed",
  "output": "The R200 router supports up to 32 connected devices."
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: toolGeneration } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: TOOL_AGENT_ID },
  query: { wait: true },
  body: {
    messages: [
      {
        role: 'user',
        content: 'How many devices can the R200 router support?',
      },
    ],
  },
});
console.log(toolGeneration.status); // "completed"
console.log(toolGeneration.output.content); // "...32 connected devices..."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/agents/$TOOL_AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"How many devices can the R200 router support?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

An agent can carry both `knowledge_config` and a `builtin` knowledge tool: automatic
context every turn plus a self-written follow-up query.

---

## What you built

Ingest more PDFs under `/manuals/` and the agent picks them up with no config change.
For larger sets, use nested prefixes (`/manuals/network/`, `/manuals/print/`) and point
different agents at different subtrees.
