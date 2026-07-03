---
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingest Images and Audio with Converters

Native [file ingestion](/docs/modules/documents#file-ingestion-and-chunking) turns
PDFs and text files into searchable [Documents](/docs/modules/documents#examples).
This tutorial extends it to **images and audio** by routing each unsupported
`content_type` to a converter through an
[Ingestion Rule](/docs/modules/ingestion-rules#examples) — and demonstrates the
**two converter kinds** side by side, each used for what it's naturally good at:

- **Images and scanned PDFs → an [agent converter](/docs/modules/ingestion-rules#converter-tool-or-agent)**
  backed by an [OpenAI](https://platform.openai.com/docs) vision model. SOAT
  feeds the file to the model with a fixed "extract all text" instruction and
  stores its output — zero plumbing, no request/response mapping to write.
- **Audio → a [tool converter](/docs/modules/ingestion-rules#converter-tool-or-agent)**
  calling [xAI](https://docs.x.ai/docs/overview)'s real speech-to-text REST API
  directly. That API isn't chat-completions-shaped — it's a dedicated
  `multipart/form-data` endpoint, so an LLM agent can't call it at all. This is
  exactly the case a tool converter is for: a plain [`http` tool](/docs/modules/tools#http)
  wrapped in a [`pipeline` tool](/docs/modules/tools#pipeline) to reshape the
  response, with the API key held as a [secret reference](/docs/modules/secrets#secret-references-secret)
  rather than a raw value.

Both routes reuse the same chunk + embed pipeline, so the converted text ends up
searchable like any other document, and nothing is hosted outside SOAT either way.

It maps onto the feature's building blocks:

| Building block | Where in this tutorial |
| -------------- | ----------------------- |
| **Agent converter** — a multimodal model extracts text, no plumbing | Part A |
| **Tool converter** — an `http` tool calls a real REST API directly, a `pipeline` tool reshapes its response | Part B |
| **Ingestion rules** — `content_type` → converter routing | Steps 6, 7, 12 |
| **Automatic routing** — ingest without naming a converter | Steps 8, 13 |
| **Secret references** — a tool's API key never appears in `GET`/`LIST` responses | Step 10 |
| **`body_mode: multipart`** — calling a non-JSON third-party API directly | Step 10 |

:::tip Runs against mock providers — no keys needed
Every provider/tool call is directed at a `base_url` you configure, so the flow
can run against stand-in servers instead of the real APIs. The tutorials test
runner does exactly this: `tests/docker-compose.tutorials.yml` starts a
`mock-providers` service (`tests/mocks/mock-providers.mjs`) that answers the
OpenAI Responses API (image OCR) and a mock xAI speech-to-text endpoint (audio
transcription) with canned text — but only after checking that the bytes it
received match the fixture files checked into this tutorial
(`fixtures/receipt.png`, `fixtures/meeting.mp3`) byte-for-byte, so a broken
tutorial fails loudly in CI instead of silently passing on the wrong input.
:::

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (storing provider keys as secrets), see
  [Advanced Configuration](/docs/getting-started/advanced-config).
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Provider credentials for **real** runs: an
  [OpenAI API key](https://platform.openai.com/docs) with access to a **vision**
  model (`gpt-4o` or similar), and an [xAI API key](https://docs.x.ai/docs/overview)
  with access to its [speech-to-text endpoint](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text).
  For provider setup patterns see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
  No other infrastructure required — and neither key is needed when running
  against the mock providers described above.
- The fixture files this tutorial uploads are checked into the repo at
  `packages/website/docs/tutorials/fixtures/` (`receipt.png`, `meeting.mp3`).
  The commands below embed them as base64 so they work from any shell; if
  you're following along locally, the same bytes are on disk at that path.

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1

# Provider endpoints and keys. The defaults are the real providers; each is
# overridable so the tutorial can also run against local mocks (see the tip above).
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-your-openai-key}"
export XAI_BASE_URL="${XAI_BASE_URL:-https://api.x.ai/v1}"
export XAI_API_KEY="${XAI_API_KEY:-xai-your-key}"
```

---

## Step 1 — Log in as admin

Admin is the built-in superuser and bypasses policy evaluation. See
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

You point an [Ingestion Rule](/docs/modules/ingestion-rules#converter-tool-or-agent)
at an agent and SOAT sends the file to it as multimodal input with a fixed "extract
all text" instruction — no request/response mapping to write. For images and scanned
PDFs, an OpenAI vision model does OCR directly.

## Step 3 — Store the OpenAI key as a secret

The agent authenticates through an [AI provider](/docs/modules/ai-providers#examples),
and the provider reads its credentials from a [Secret](/docs/modules/secrets#examples)
rather than an inline key — so the key is encrypted at rest and never returned in API
responses.

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

Create an [AI provider](/docs/modules/ai-providers#examples) backed by OpenAI with a
vision-capable `default_model`, reading its key from the secret above. `base_url`
points at OpenAI (overridden to the mock in CI).

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

Create an [agent](/docs/modules/agents#examples) whose only job is to transcribe what
it sees. The instructions matter most here: keep the model from summarizing or
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

Create an [Ingestion Rule](/docs/modules/ingestion-rules#examples) mapping `image/*`
to the agent with `agent_id`. Agent converters take the file directly, so there is no
`file_delivery` to choose and no request shape to map.

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

A scanned PDF has `content_type: application/pdf` but no text layer, so the native
parser yields nothing. A rule matching `application/pdf` is consulted **only when
native extraction returns no text** — see
[Ingestion Rules — Content-Type Matching](/docs/modules/ingestion-rules#content-type-matching).
Pointing it at the same vision agent makes it a scanned-PDF fallback; born-digital PDFs
still skip the converter. (To OCR every PDF regardless of its text layer, set
`native_extraction: skip` on the rule.)

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

Upload an image as a [File](/docs/modules/files#examples), then ingest it exactly like
a PDF or text file. Nothing about the call names the agent or the rule —
`POST /documents/ingest` resolves the matching rule from the file's `content_type`
automatically. Uploading via base64 lets us set `content_type` explicitly to
`image/png`, which is what drives routing. `RECEIPT_PNG_B64` below is the exact
base64 of the real fixture checked into this tutorial at
[`fixtures/receipt.png`](https://github.com/ttoss/soat/blob/main/packages/website/docs/tutorials/fixtures/receipt.png) —
a small receipt image with real text for the model to OCR.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RECEIPT_PNG_B64="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"

IMAGE_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "receipt.png" \
  --content-type "image/png" \
  --content "$RECEIPT_PNG_B64" | jq -r '.id')
echo "IMAGE_FILE_ID: $IMAGE_FILE_ID"

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$IMAGE_FILE_ID" \
  --path-prefix "/images/" \
  --async false | jq -e '.status == "ready"'
# prints `true` once the image is OCR'd, chunked, and embedded
# (chunk_count is reported under .metadata; Step 14 confirms the text is searchable)
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const RECEIPT_PNG_B64 = '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';

const { data: imageFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'receipt.png',
    content_type: 'image/png',
    content: RECEIPT_PNG_B64,
  },
});

const { data: imageDoc } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: { project_id: PROJECT_ID, file_id: imageFile.id, path_prefix: '/images/' },
});
console.log(imageDoc.status, imageDoc.metadata?.chunk_count); // "ready" 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RECEIPT_PNG_B64="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"

IMAGE_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"receipt.png\",\"content_type\":\"image/png\",\"content\":\"$RECEIPT_PNG_B64\"}" \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/ingest?async=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$IMAGE_FILE_ID\",\"path_prefix\":\"/images/\"}" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

That is the whole image path: a secret, a provider, an agent, and one rule — no JSON
Logic, no request/response mapping. For most OCR and vision workloads this is all you
need. (Against a **real** OpenAI account the model occasionally needs a retry — like
any LLM call, an agent converter generation can intermittently return a non-answer
instead of acting on the input; re-ingest with `soat reingest-document` if `.status`
comes back `failed`.)

---

## Part B — Audio via an xAI tool converter

xAI exposes a real, dedicated [speech-to-text REST API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
(`POST /v1/stt`) — not a chat-completions endpoint, so no agent can call it. This is
exactly the case [tool converters](/docs/modules/ingestion-rules#converter-tool-or-agent)
are for: an [`http` tool](/docs/modules/tools#http) points `execute.url` directly at
the API, and a [`pipeline` tool](/docs/modules/tools#pipeline) wraps it to turn xAI's
JSON response into the bare-string shape [ingestion rules expect](/docs/modules/ingestion-rules#converter-tool-contract).
See [Ingestion Rules — Building a Tool Converter for a Third-Party API](/docs/modules/ingestion-rules#building-a-tool-converter-for-a-third-party-api)
for the general pattern this tutorial follows.

## Step 9 — Store the xAI key as a secret

Same pattern as Step 3. Keeping the key in a [Secret](/docs/modules/secrets#examples)
means it is encrypted at rest — and unlike an agent's `AiProvider.secret_id`, a tool's
`execute.headers` can only reference it through a
[secret reference](/docs/modules/secrets#secret-references-secret) token, never a raw
value (see Step 10).

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

Create an [`http` tool](/docs/modules/tools#http) pointed directly at xAI's `/stt`
endpoint (overridden to the mock in CI via `$XAI_BASE_URL`). Two things make this work
against a real, non-chat REST API:

- **`{{secret:...}}` in `execute.headers`** — the raw key is never stored on the tool;
  `GET`/`LIST` echo back the `{{secret:...}}` token, and it resolves to the decrypted
  value only right before the outbound request. See
  [Secrets — Secret References](/docs/modules/secrets#secret-references-secret).
- **`execute.body_mode: "multipart"`** — xAI's `/stt` endpoint requires
  `multipart/form-data` and rejects a JSON body outright. With `body_mode: multipart`,
  the `file` field (the `{ content_type, filename, data_base64 }` shape an ingestion
  rule passes) is base64-decoded and attached as a real file part; scalar fields become
  plain form fields. See [Tools — Request Body Encoding](/docs/modules/tools#request-body-encoding-body_mode).

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

xAI's `/stt` response is `{ "text": "...", "language": "...", "duration": ..., "words": [...] }`
— an object, not the bare string an
[ingestion rule tool converter](/docs/modules/ingestion-rules#converter-tool-contract)
requires. A [`pipeline` tool](/docs/modules/tools#pipeline) calls the `http` tool as its
one step and its `output` resolves straight to `steps.call.text` — a single `var`
expression as the whole `output` mapping resolves to that bare scalar directly, per
[Ingestion Rules — Building a Tool Converter for a Third-Party API](/docs/modules/ingestion-rules#building-a-tool-converter-for-a-third-party-api).

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

Map `audio/*` to the pipeline tool with `tool_id` — the counterpart of Step 6's
`agent_id`. A transcript is one long block of text, so chunk it with the `size`
strategy for sharper retrieval — see
[Documents — File Ingestion and Chunking](/docs/modules/documents#file-ingestion-and-chunking).
`preset_parameters` merges a fixed `language` into every call, the same way it would
for any other tool.

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

Same call shape as the image, different file. The `audio/*` rule from Step 12 routes it
to the tool converter via `POST /documents/ingest` — the caller never names a tool. See
[Documents](/docs/modules/documents#examples). `MEETING_MP3_B64` is the exact base64 of
the real fixture checked into this tutorial at
[`fixtures/meeting.mp3`](https://github.com/ttoss/soat/blob/main/packages/website/docs/tutorials/fixtures/meeting.mp3) —
a few seconds of real speech.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MEETING_MP3_B64="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qqqqqqqqqqqqqqqq//PExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//PExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"

AUDIO_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "meeting.mp3" \
  --content-type "audio/mpeg" \
  --content "$MEETING_MP3_B64" | jq -r '.id')
echo "AUDIO_FILE_ID: $AUDIO_FILE_ID"

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$AUDIO_FILE_ID" \
  --path-prefix "/audio/" \
  --async false | jq -e '.status == "ready"'
# prints `true` once the audio is transcribed, chunked, and embedded
# (chunk_count is reported under .metadata; Step 14 confirms the text is searchable)
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const MEETING_MP3_B64 = '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qqqqqqqqqqqqqqqq//PExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//PExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const { data: audioFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'meeting.mp3',
    content_type: 'audio/mpeg',
    content: MEETING_MP3_B64,
  },
});

const { data: audioDoc } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: { project_id: PROJECT_ID, file_id: audioFile.id, path_prefix: '/audio/' },
});
console.log(audioDoc.status, audioDoc.metadata?.chunk_count);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MEETING_MP3_B64="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qqqqqqqqqqqqqqqq//PExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//PExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"

AUDIO_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"meeting.mp3\",\"content_type\":\"audio/mpeg\",\"content\":\"$MEETING_MP3_B64\"}" \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/ingest?async=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$AUDIO_FILE_ID\",\"path_prefix\":\"/audio/\"}" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

---

## Step 14 — Search the converted content

Both documents are chunked and embedded like any other. Query them through
[Knowledge](/docs/modules/knowledge#examples) — the OCR and transcript text is fully
searchable, regardless of which converter kind produced it.

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
for (const r of imageSearch.results) console.log(r.document_id, r.score);

const { data: audioSearch } = await adminSoat.knowledge.searchKnowledge({
  body: {
    project_id: PROJECT_ID,
    query: 'when is the launch scheduled',
    document_paths: ['/audio/'],
    limit: 3,
  },
});
for (const r of audioSearch.results) console.log(r.document_id, r.score);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"total amount on the receipt\",\"document_paths\":[\"/images/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, score, content}]'

curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"when is the launch scheduled\",\"document_paths\":[\"/audio/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, score, content}]'
```

</TabItem>
</Tabs>

---

## What you built

- **An agent converter** — an OpenAI vision agent routed to by `image/*` and scanned
  `application/pdf` rules. Its key lives in a [Secret](/docs/modules/secrets#examples)
  referenced by the [AI provider](/docs/modules/ai-providers#examples)'s `secret_id`.
  Zero plumbing: the highest-level way to OCR images with an LLM.
- **A tool converter** — an `http` tool calling xAI's real speech-to-text REST API
  directly (`body_mode: multipart`, key held as a `{{secret:...}}` reference in
  `execute.headers`), wrapped in a `pipeline` tool that reshapes the response into a
  bare string. Routed to by `audio/*`. This is the pattern for wrapping any real,
  non-chat third-party API — see
  [Ingestion Rules — Building a Tool Converter for a Third-Party API](/docs/modules/ingestion-rules#building-a-tool-converter-for-a-third-party-api).
- **Two ingestion rules** routing `image/*` and `audio/*` to those converters (plus the
  optional scanned-PDF fallback), and **fully automatic ingestion** —
  `POST /documents/ingest` never names a converter; the matching rule is resolved from
  `content_type` every time.

Reach for an **agent converter** first when a multimodal LLM can do the job directly —
it's the simplest path and keeps credentials in a secret with zero request mapping.
Reach for a **tool converter** when you need a dedicated non-LLM API (a specialized
OCR/STT engine, like this tutorial's xAI example) or an async job — tool converters also
support a [`{ status: "pending" }` async-callback](/docs/modules/ingestion-rules#synchronous-vs-async-callback-conversion)
contract for background jobs that an agent converter can't defer to.

To support another modality (e.g. video), add one rule pointing at a converter — no
server changes, no new deployment, ever. To provision this whole pipeline declaratively
instead of one API call at a time, see
[Deploy a Multi-Agent App with Agent Formation](/docs/tutorials/formations) — the
`ingestion_rule` resource type ([reference](/docs/formations-types/ingestion-rule))
works the same way as every other resource shown there.
