---
description: "Ingest images and audio into searchable documents using converter tools and ingestion rules."
keywords:
  - multimodal ingestion
  - OCR
  - speech to text
  - audio transcription
  - converter tools
sidebar_position: 9
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingest Images and Audio with Converters

Native [file ingestion](/docs/modules/documents#file-ingestion-and-chunking) handles
PDFs and text. An [Ingestion Rule](/docs/modules/ingestion-rules#examples) routes any
other `content_type` to a converter; this tutorial shows both converter kinds:

- **Images and scanned PDFs → [agent converter](/docs/modules/ingestion-rules#converter-tool-or-agent)**
  backed by an [OpenAI](https://platform.openai.com/docs) vision model; no
  request/response mapping (Part A).
- **Audio → [tool converter](/docs/modules/ingestion-rules#converter-tool-or-agent)**
  calling [xAI](https://docs.x.ai/docs/overview)'s speech-to-text REST API, a
  `multipart/form-data` endpoint an agent cannot call: an
  [`http` tool](/docs/modules/tools#http) wrapped in a
  [`pipeline` tool](/docs/modules/tools#pipeline), API key held as a
  [secret reference](/docs/modules/secrets#secret-references-secret) (Part B).

Both routes share the chunk + embed pipeline, so converted text is searchable like any
[Document](/docs/modules/documents#examples).

:::tip[Runs against mock providers]
Every provider/tool call targets a `base_url` you configure. The tutorials runner uses
the `mock-providers` service in `tests/docker-compose.tutorials.yml`, which answers with
canned text after verifying the received bytes match the checked-in fixtures.
:::

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [CLI](/docs/cli) or [SDK](/docs/sdk).
- For real runs: an [OpenAI API key](https://platform.openai.com/docs) with a vision
  model (`gpt-4o` or similar) and an [xAI API key](https://docs.x.ai/docs/overview) with
  [speech-to-text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
  access ([Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms)). Neither is
  needed against the mock providers.
- Fixtures `receipt.png` and `meeting.mp3` live at
  `packages/website/docs/tutorials/fixtures/` in the [SOAT repo](https://github.com/ttoss/soat);
  run from the repo root, where `$FIXTURES_DIR` points by default.

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1

# Provider endpoints and keys. The defaults are the real providers; each is
# overridable so the tutorial can also run against local mocks (see the tip above).
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-your-openai-key}"
export XAI_BASE_URL="${XAI_BASE_URL:-https://api.x.ai/v1}"
export XAI_API_KEY="${XAI_API_KEY:-xai-your-key}"

# Where this tutorial's fixture files live — override if your clone (or the
# directory you copied fixtures/ into) is somewhere else.
export FIXTURES_DIR="${FIXTURES_DIR:-./packages/website/docs/tutorials/fixtures}"
```

---

## Step 1 — Log in as admin

See [Users](/docs/modules/users#examples).

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

## Step 2 — Create a project

Every resource lives inside a [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Media Ingestion" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Media Ingestion' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Media Ingestion"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Part A — Images and scanned PDFs via an OpenAI agent converter

An [Ingestion Rule](/docs/modules/ingestion-rules#converter-tool-or-agent) pointed at
an agent sends the file as multimodal input with a fixed "extract all text" instruction;
a vision model does the OCR.

## Step 3 — Store the OpenAI key as a secret

The [AI provider](/docs/modules/ai-providers#examples) reads its credentials from a
[Secret](/docs/modules/secrets#examples): encrypted at rest, never returned in responses.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OPENAI_SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "openai-api-key" \
  --value "$OPENAI_API_KEY" | jq -r '.id')
echo "OPENAI_SECRET_ID: $OPENAI_SECRET_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: openaiSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-api-key',
    value: process.env.OPENAI_API_KEY!,
  },
});
const OPENAI_SECRET_ID = openaiSecret.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OPENAI_SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"openai-api-key\",\"value\":\"$OPENAI_API_KEY\"}" \
  | jq -r '.id')
echo "OPENAI_SECRET_ID: $OPENAI_SECRET_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create a vision AI provider

An OpenAI [AI provider](/docs/modules/ai-providers#examples) with a vision-capable
`default_model`, key from the secret above; `base_url` is overridden to the mock in CI.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OPENAI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "OpenAI Vision" \
  --provider "openai" \
  --default-model "gpt-4o" \
  --base-url "$OPENAI_BASE_URL" \
  --secret-id "$OPENAI_SECRET_ID" | jq -r '.id')
echo "OPENAI_PROVIDER_ID: $OPENAI_PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: openaiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'OpenAI Vision',
    provider: 'openai',
    default_model: 'gpt-4o',
    base_url: process.env.OPENAI_BASE_URL,
    secret_id: OPENAI_SECRET_ID,
  },
});
const OPENAI_PROVIDER_ID = openaiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OPENAI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"OpenAI Vision\",\"provider\":\"openai\",\"default_model\":\"gpt-4o\",\"base_url\":\"$OPENAI_BASE_URL\",\"secret_id\":\"$OPENAI_SECRET_ID\"}" \
  | jq -r '.id')
echo "OPENAI_PROVIDER_ID: $OPENAI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create the OCR agent

An [agent](/docs/modules/agents#examples) whose instructions forbid summarizing or
commenting, so the document text is the raw extracted content.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OCR_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$OPENAI_PROVIDER_ID" \
  --name "OCR Agent" \
  --instructions "Extract all text from the provided file verbatim. Return plain text only — no commentary, no summary, no markdown fences." \
  | jq -r '.id')
echo "OCR_AGENT_ID: $OCR_AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: ocrAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: OPENAI_PROVIDER_ID,
    name: 'OCR Agent',
    instructions:
      'Extract all text from the provided file verbatim. Return plain text only — no commentary, no summary, no markdown fences.',
  },
});
const OCR_AGENT_ID = ocrAgent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OCR_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$OPENAI_PROVIDER_ID\",\"name\":\"OCR Agent\",\"instructions\":\"Extract all text from the provided file verbatim. Return plain text only — no commentary, no summary, no markdown fences.\"}" \
  | jq -r '.id')
echo "OCR_AGENT_ID: $OCR_AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Route images to the agent

An [Ingestion Rule](/docs/modules/ingestion-rules#examples) maps `image/*` to the agent
via `agent_id`. Agent converters take the file directly: no `file_delivery`, no request
shape.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "image/*" \
  --agent-id "$OCR_AGENT_ID" \
  --chunk-strategy "whole" | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.ingestionRules.createIngestionRule({
  body: {
    project_id: PROJECT_ID,
    content_type_glob: 'image/*',
    agent_id: OCR_AGENT_ID,
    chunk_strategy: 'whole',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/ingestion-rules" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"image/*\",\"agent_id\":\"$OCR_AGENT_ID\",\"chunk_strategy\":\"whole\"}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

---

## Step 7 — (Optional) OCR fallback for scanned PDFs

A scanned PDF has `content_type: application/pdf` and no text layer. A rule matching
`application/pdf` is consulted only when native extraction returns no text
([Ingestion Rules — Content-Type Matching](/docs/modules/ingestion-rules#content-type-matching)),
so pointing it at the vision agent OCRs scanned PDFs while born-digital PDFs skip the
converter. `native_extraction: skip` on the rule OCRs every PDF.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "application/pdf" \
  --agent-id "$OCR_AGENT_ID" \
  --chunk-strategy "whole" | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.ingestionRules.createIngestionRule({
  body: {
    project_id: PROJECT_ID,
    content_type_glob: 'application/pdf',
    agent_id: OCR_AGENT_ID,
    chunk_strategy: 'whole',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/ingestion-rules" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"application/pdf\",\"agent_id\":\"$OCR_AGENT_ID\",\"chunk_strategy\":\"whole\"}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

---

## Step 8 — Ingest an image without naming a converter

Upload an image as a [File](/docs/modules/files#examples), then ingest it like a PDF.
[`POST /documents/ingest`](/docs/api/documents/ingest-document) resolves the rule from
the file's `content_type`; the base64 upload sets it explicitly to `image/png`.
[`$FIXTURES_DIR/receipt.png`](https://github.com/ttoss/soat/blob/main/packages/website/docs/tutorials/fixtures/receipt.png)
is a small receipt image.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
IMAGE_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "receipt.png" \
  --content-type "image/png" \
  --content "$(base64 -w0 "$FIXTURES_DIR/receipt.png")" | jq -r '.id')
echo "IMAGE_FILE_ID: $IMAGE_FILE_ID"

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$IMAGE_FILE_ID" \
  --path-prefix "/images/" \
  --wait true | jq -e '.status == "ready"'
# prints `true` once the image is OCR'd, chunked, and embedded
# (chunk_count is reported by `soat get-document-status`; Step 14 confirms the text is searchable)
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import fs from 'node:fs';
import path from 'node:path';

const RECEIPT_PNG_B64 = fs
  .readFileSync(path.join(process.env.FIXTURES_DIR!, 'receipt.png'))
  .toString('base64');

const { data: imageFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'receipt.png',
    content_type: 'image/png',
    content: RECEIPT_PNG_B64,
  },
});

const { data: imageDoc } = await adminSoat.documents.ingestDocument({
  query: { wait: true },
  body: { project_id: PROJECT_ID, file_id: imageFile.id, path_prefix: '/images/' },
});
const { data: imageStatus } = await adminSoat.documents.getDocumentStatus({
  path: { document_id: imageDoc.id },
});
console.log(imageStatus.status, imageStatus.chunk_count); // "ready" 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RECEIPT_PNG_B64=$(base64 -w0 "$FIXTURES_DIR/receipt.png")

IMAGE_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"receipt.png\",\"content_type\":\"image/png\",\"content\":\"$RECEIPT_PNG_B64\"}" \
  | jq -r '.id')

IMAGE_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/ingest?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$IMAGE_FILE_ID\",\"path_prefix\":\"/images/\"}" \
  | jq -r '.id')
curl -s "$SOAT_BASE_URL/api/v1/documents/$IMAGE_DOC_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

Against a real OpenAI account the model occasionally returns a non-answer; re-ingest
with `soat reingest-document` if `.status` is `failed`.

---

## Part B — Audio via an xAI tool converter

xAI's [speech-to-text REST API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
(`POST /v1/stt`) is not a chat-completions endpoint, so it needs a
[tool converter](/docs/modules/ingestion-rules#converter-tool-or-agent): an
[`http` tool](/docs/modules/tools#http) calls the API and a
[`pipeline` tool](/docs/modules/tools#pipeline) reshapes the response into the
bare-string [converter contract](/docs/modules/ingestion-rules#converter-tool-contract).
Pattern: [Ingestion Rules — Building a Tool Converter for a Third-Party API](/docs/modules/ingestion-rules#building-a-tool-converter-for-a-third-party-api).

## Step 9 — Store the xAI key as a secret

As in Step 3. The tool's `execute.headers` will reference the
[Secret](/docs/modules/secrets#examples) through a
[secret reference](/docs/modules/secrets#secret-references-secret) token (Step 10).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
XAI_SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "xai-api-key" \
  --value "$XAI_API_KEY" | jq -r '.id')
echo "XAI_SECRET_ID: $XAI_SECRET_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: xaiSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-api-key',
    value: process.env.XAI_API_KEY!,
  },
});
const XAI_SECRET_ID = xaiSecret.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
XAI_SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-api-key\",\"value\":\"$XAI_API_KEY\"}" \
  | jq -r '.id')
echo "XAI_SECRET_ID: $XAI_SECRET_ID"
```

</TabItem>
</Tabs>

---

## Step 10 — Create the speech-to-text tool

An [`http` tool](/docs/modules/tools#http) pointed at xAI's `/stt` endpoint (the mock
in CI via `$XAI_BASE_URL`):

- **`{{secret:...}}` in `execute.headers`** resolves right before the outbound request;
  the raw key is never stored on the tool
  ([Secrets — Secret References](/docs/modules/secrets#secret-references-secret)).
- **`execute.body_mode: "multipart"`** sends `multipart/form-data`; the `file` field is
  base64-decoded into a real file part
  ([Tools — Request Body Encoding](/docs/modules/tools#request-body-encoding-body_mode)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STT_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "xai-stt" \
  --type http \
  --description "Transcribes audio via xAI's speech-to-text API" \
  --execute '{"url":"'"$XAI_BASE_URL"'/stt","method":"POST","body_mode":"multipart","headers":{"Authorization":"Bearer {{secret:'"$XAI_SECRET_ID"'}}"}}' \
  --parameters '{"type":"object","properties":{"file":{"type":"object"},"language":{"type":"string"}}}' \
  | jq -r '.id')
echo "STT_TOOL_ID: $STT_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sttTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-stt',
    type: 'http',
    description: "Transcribes audio via xAI's speech-to-text API",
    execute: {
      url: `${process.env.XAI_BASE_URL}/stt`,
      method: 'POST',
      body_mode: 'multipart',
      headers: { Authorization: `Bearer {{secret:${XAI_SECRET_ID}}}` },
    },
    parameters: {
      type: 'object',
      properties: { file: { type: 'object' }, language: { type: 'string' } },
    },
  },
});
const STT_TOOL_ID = sttTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
STT_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-stt\",\"type\":\"http\",\"description\":\"Transcribes audio via xAI's speech-to-text API\",\"execute\":{\"url\":\"$XAI_BASE_URL/stt\",\"method\":\"POST\",\"body_mode\":\"multipart\",\"headers\":{\"Authorization\":\"Bearer {{secret:$XAI_SECRET_ID}}\"}},\"parameters\":{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"object\"},\"language\":{\"type\":\"string\"}}}}" \
  | jq -r '.id')
echo "STT_TOOL_ID: $STT_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 11 — Wrap it in a pipeline to extract the transcript

`/stt` returns an object (`{ "text": "...", ... }`), not the bare string a
[tool converter](/docs/modules/ingestion-rules#converter-tool-contract) requires; the
pipeline's `output` `{ "var": "steps.call.text" }` extracts it. An `http` tool's
[`output_mapping`](/docs/modules/tools#output-mapping) could do the same on `xai-stt`
alone; the two-tool version shows chaining.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STT_CONVERTER_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "xai-stt-converter" \
  --type pipeline \
  --description "Calls the xAI STT tool and extracts the transcript as a bare string" \
  --pipeline '{"steps":[{"id":"call","tool_id":"'"$STT_TOOL_ID"'","input":{"file":{"var":"input.file"},"language":{"var":"input.language"}}}],"output":{"var":"steps.call.text"}}' \
  | jq -r '.id')
echo "STT_CONVERTER_ID: $STT_CONVERTER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sttConverter } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-stt-converter',
    type: 'pipeline',
    description: 'Calls the xAI STT tool and extracts the transcript as a bare string',
    pipeline: {
      steps: [
        {
          id: 'call',
          tool_id: STT_TOOL_ID,
          input: { file: { var: 'input.file' }, language: { var: 'input.language' } },
        },
      ],
      output: { var: 'steps.call.text' },
    },
  },
});
const STT_CONVERTER_ID = sttConverter.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
STT_CONVERTER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-stt-converter\",\"type\":\"pipeline\",\"description\":\"Calls the xAI STT tool and extracts the transcript as a bare string\",\"pipeline\":{\"steps\":[{\"id\":\"call\",\"tool_id\":\"$STT_TOOL_ID\",\"input\":{\"file\":{\"var\":\"input.file\"},\"language\":{\"var\":\"input.language\"}}}],\"output\":{\"var\":\"steps.call.text\"}}}" \
  | jq -r '.id')
echo "STT_CONVERTER_ID: $STT_CONVERTER_ID"
```

</TabItem>
</Tabs>

---

## Step 12 — Route audio to the tool converter

Map `audio/*` to the pipeline tool with `tool_id`. A transcript is one long block, so
chunk it with the `size` strategy
([Documents — File Ingestion and Chunking](/docs/modules/documents#file-ingestion-and-chunking)).
`preset_parameters` merges a fixed `language` into every call.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "audio/*" \
  --tool-id "$STT_CONVERTER_ID" \
  --file-delivery base64 \
  --preset-parameters '{"language":"en"}' \
  --chunk-strategy "size" \
  --chunk-size 1000 \
  --chunk-overlap 200 | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.ingestionRules.createIngestionRule({
  body: {
    project_id: PROJECT_ID,
    content_type_glob: 'audio/*',
    tool_id: STT_CONVERTER_ID,
    file_delivery: 'base64',
    preset_parameters: { language: 'en' },
    chunk_strategy: 'size',
    chunk_size: 1000,
    chunk_overlap: 200,
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/ingestion-rules" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"audio/*\",\"tool_id\":\"$STT_CONVERTER_ID\",\"file_delivery\":\"base64\",\"preset_parameters\":{\"language\":\"en\"},\"chunk_strategy\":\"size\",\"chunk_size\":1000,\"chunk_overlap\":200}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

---

## Step 13 — Ingest audio the same way

Same call shape as the image; the `audio/*` rule routes it ([Documents](/docs/modules/documents#examples)).
[`$FIXTURES_DIR/meeting.mp3`](https://github.com/ttoss/soat/blob/main/packages/website/docs/tutorials/fixtures/meeting.mp3)
is a few seconds of real speech.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AUDIO_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "meeting.mp3" \
  --content-type "audio/mpeg" \
  --content "$(base64 -w0 "$FIXTURES_DIR/meeting.mp3")" | jq -r '.id')
echo "AUDIO_FILE_ID: $AUDIO_FILE_ID"

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$AUDIO_FILE_ID" \
  --path-prefix "/audio/" \
  --wait true | jq -e '.status == "ready"'
# prints `true` once the audio is transcribed, chunked, and embedded
# (chunk_count is reported by `soat get-document-status`; Step 14 confirms the text is searchable)
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import fs from 'node:fs';
import path from 'node:path';

const MEETING_MP3_B64 = fs
  .readFileSync(path.join(process.env.FIXTURES_DIR!, 'meeting.mp3'))
  .toString('base64');

const { data: audioFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'meeting.mp3',
    content_type: 'audio/mpeg',
    content: MEETING_MP3_B64,
  },
});

const { data: audioDoc } = await adminSoat.documents.ingestDocument({
  query: { wait: true },
  body: { project_id: PROJECT_ID, file_id: audioFile.id, path_prefix: '/audio/' },
});
const { data: audioStatus } = await adminSoat.documents.getDocumentStatus({
  path: { document_id: audioDoc.id },
});
console.log(audioStatus.status, audioStatus.chunk_count);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MEETING_MP3_B64=$(base64 -w0 "$FIXTURES_DIR/meeting.mp3")

AUDIO_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"meeting.mp3\",\"content_type\":\"audio/mpeg\",\"content\":\"$MEETING_MP3_B64\"}" \
  | jq -r '.id')

AUDIO_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/ingest?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$AUDIO_FILE_ID\",\"path_prefix\":\"/audio/\"}" \
  | jq -r '.id')
curl -s "$SOAT_BASE_URL/api/v1/documents/$AUDIO_DOC_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

---

## Step 14 — Search the converted content

Both documents are chunked and embedded like any other; query them through
[Knowledge](/docs/modules/knowledge#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# The OCR'd receipt text is retrievable
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "total amount on the receipt" \
  --document-paths '["/images/"]' \
  --limit 3 | jq -e '[.results[].content] | join(" ") | test("Total amount")'

# The transcribed audio is retrievable
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "when is the launch scheduled" \
  --document-paths '["/audio/"]' \
  --limit 3 | jq -e '[.results[].content] | join(" ") | test("launch is next tuesday"; "i")'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: imageSearch } = await adminSoat.knowledge.searchKnowledge({
  body: {
    project_id: PROJECT_ID,
    query: 'total amount on the receipt',
    document_paths: ['/images/'],
    limit: 3,
  },
});
for (const r of imageSearch.results) console.log(r.document_id, r.similarity_score);

const { data: audioSearch } = await adminSoat.knowledge.searchKnowledge({
  body: {
    project_id: PROJECT_ID,
    query: 'when is the launch scheduled',
    document_paths: ['/audio/'],
    limit: 3,
  },
});
for (const r of audioSearch.results) console.log(r.document_id, r.similarity_score);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"total amount on the receipt\",\"document_paths\":[\"/images/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, similarity_score, content}]'

curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"when is the launch scheduled\",\"document_paths\":[\"/audio/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, similarity_score, content}]'
```

</TabItem>
</Tabs>

---

## Next steps

Use an agent converter when a multimodal LLM can do the job; a tool converter for a
non-LLM API or an
[async-callback](/docs/modules/ingestion-rules#synchronous-vs-async-callback-conversion)
background job. Another modality (video) is one more rule, no server changes.

- [Ingestion Rules — Building a Tool Converter for a Third-Party API](/docs/modules/ingestion-rules#building-a-tool-converter-for-a-third-party-api)
- [Deploy a Multi-Agent App with Agent Formation](/docs/tutorials/formations) — the
  [`ingestion_rule` resource type](/docs/formations-types/ingestion-rule) provisions this declaratively.
