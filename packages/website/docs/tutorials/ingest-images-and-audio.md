---
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingest Images and Audio with Converters

Native [file ingestion](/docs/modules/documents#file-ingestion-and-chunking) turns
PDFs and text files into searchable [Documents](/docs/modules/documents#examples).
This tutorial extends it to **images and audio** by routing each unsupported
`content_type` to an **agent converter** through an
[Ingestion Rule](/docs/modules/ingestion-rules#examples).

An agent converter is a resource you already know — an
[Agent](/docs/modules/agents#examples) backed by a multimodal model. SOAT feeds
the uploaded file to the model with a fixed "extract all text" instruction and
stores the model's text output as the document. **Zero plumbing**: no
request/response mapping to write, and the provider key lives in a
[Secret](/docs/modules/secrets#examples), encrypted at rest.

We wire up two of them, one per modality — using the providers each is best at:

- **Images and scanned PDFs → [OpenAI](https://platform.openai.com/docs)** vision
  model (OCR).
- **Audio → [xAI](https://docs.x.ai/docs/overview)** (speech-to-text). xAI exposes
  an OpenAI-compatible API, so we register it as an OpenAI-compatible provider and
  point its `base_url` at xAI.

Both routes reuse the same chunk + embed pipeline, so the converted text ends up
searchable like any other document, and nothing is hosted outside SOAT either way.

It maps onto the feature's building blocks:

| Building block | Where in this tutorial |
| -------------- | ----------------------- |
| **Agent converter** — a multimodal model extracts text, no plumbing | Parts A & B |
| **Ingestion rules** — `content_type` → converter routing | Steps 6, 7, 12 |
| **Automatic routing** — ingest without naming a converter | Steps 8, 13 |
| **Provider-agnostic converters** — OpenAI for vision, xAI for audio | Steps 4, 10 |

:::tip Runs against mock providers — no keys needed
Every provider call is directed at the `base_url` you configure on each AI
provider, so the flow can run against stand-in servers instead of the real APIs.
The tutorials test runner does exactly this: `tests/docker-compose.tutorials.yml`
starts a `mock-providers` service (`tests/mocks/mock-providers.mjs`) that answers
the OpenAI Responses API (vision OCR) and the OpenAI-compatible Chat Completions
API (xAI transcription) with canned text, and sets `OPENAI_BASE_URL` /
`XAI_BASE_URL` to it — so the whole ingest → convert → search flow is validated
end-to-end in CI with no external keys.
:::

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (storing provider keys as secrets), see
  [Advanced Configuration](/docs/getting-started/advanced-config).
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Provider credentials for **real** runs: an
  [OpenAI API key](https://platform.openai.com/docs) with access to a **vision**
  model, and an [xAI API key](https://docs.x.ai/docs/overview). For provider setup
  patterns see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
  No other infrastructure required — and neither key is needed when running against
  the mock providers described above.

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

## Part A — Images and scanned PDFs via an OpenAI agent

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
`image/png`, which is what drives routing. (`RECEIPT_PNG_B64` below is a tiny
placeholder PNG; the OCR model returns the same canned text against the mock.)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RECEIPT_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

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
const RECEIPT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
RECEIPT_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

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
need.

---

## Part B — Audio via an xAI agent

Audio is exactly the same shape as images, with a different provider. xAI exposes an
[OpenAI-compatible API](https://docs.x.ai/docs/overview), so we register it as an
OpenAI-compatible provider (`provider: custom`) whose `base_url` points at xAI, then
route `audio/*` at an agent backed by it. No pipeline, no request mapping — SOAT hands
the audio file to the model and stores its transcript.

## Step 9 — Store the xAI key as a secret

Same pattern as Step 3, for the [xAI](https://docs.x.ai/docs/overview) key. Keeping it
in a [Secret](/docs/modules/secrets#examples) means it is encrypted at rest and never
echoed back in API responses.

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

## Step 10 — Create an xAI AI provider

Create an [AI provider](/docs/modules/ai-providers#examples) for xAI. Because xAI
speaks the OpenAI wire protocol, we use `provider: custom` (an OpenAI-compatible
provider) and set `base_url` to xAI's endpoint (overridden to the mock in CI). See
[Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms) for other
providers and credential options.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
XAI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "xAI Audio" \
  --provider "custom" \
  --default-model "grok-4" \
  --base-url "$XAI_BASE_URL" \
  --secret-id "$XAI_SECRET_ID" | jq -r '.id')
echo "XAI_PROVIDER_ID: $XAI_PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: xaiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'xAI Audio',
    provider: 'custom',
    default_model: 'grok-4',
    base_url: process.env.XAI_BASE_URL,
    secret_id: XAI_SECRET_ID,
  },
});
const XAI_PROVIDER_ID = xaiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
XAI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xAI Audio\",\"provider\":\"custom\",\"default_model\":\"grok-4\",\"base_url\":\"$XAI_BASE_URL\",\"secret_id\":\"$XAI_SECRET_ID\"}" \
  | jq -r '.id')
echo "XAI_PROVIDER_ID: $XAI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 11 — Create the transcription agent

Create an [agent](/docs/modules/agents#examples) backed by the xAI provider whose job
is to transcribe audio verbatim.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STT_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$XAI_PROVIDER_ID" \
  --name "Transcription Agent" \
  --instructions "Transcribe the provided audio verbatim. Return plain text only — no commentary, no summary, no timestamps." \
  | jq -r '.id')
echo "STT_AGENT_ID: $STT_AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sttAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: XAI_PROVIDER_ID,
    name: 'Transcription Agent',
    instructions:
      'Transcribe the provided audio verbatim. Return plain text only — no commentary, no summary, no timestamps.',
  },
});
const STT_AGENT_ID = sttAgent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
STT_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$XAI_PROVIDER_ID\",\"name\":\"Transcription Agent\",\"instructions\":\"Transcribe the provided audio verbatim. Return plain text only — no commentary, no summary, no timestamps.\"}" \
  | jq -r '.id')
echo "STT_AGENT_ID: $STT_AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 12 — Route audio to the transcription agent

Map `audio/*` to the transcription agent. A transcript is one long block of text, so
chunk it with the `size` strategy for sharper retrieval — see
[Documents — File Ingestion and Chunking](/docs/modules/documents#file-ingestion-and-chunking).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "audio/*" \
  --agent-id "$STT_AGENT_ID" \
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
    agent_id: STT_AGENT_ID,
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"audio/*\",\"agent_id\":\"$STT_AGENT_ID\",\"chunk_strategy\":\"size\",\"chunk_size\":1000,\"chunk_overlap\":200}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

---

## Step 13 — Ingest audio the same way

Same call shape as the image, different file. The `audio/*` rule from Step 12 routes it
to the transcription agent via `POST /documents/ingest` — the caller never names an
agent. See [Documents](/docs/modules/documents#examples). (`MEETING_WAV_B64` is a tiny
placeholder WAV; the model returns the same canned transcript against the mock.)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MEETING_WAV_B64="UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA"

AUDIO_FILE_ID=$(soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --filename "meeting.wav" \
  --content-type "audio/wav" \
  --content "$MEETING_WAV_B64" | jq -r '.id')
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
const MEETING_WAV_B64 =
  'UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

const { data: audioFile } = await adminSoat.files.uploadFileBase64({
  body: {
    project_id: PROJECT_ID,
    filename: 'meeting.wav',
    content_type: 'audio/wav',
    content: MEETING_WAV_B64,
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
MEETING_WAV_B64="UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA"

AUDIO_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"filename\":\"meeting.wav\",\"content_type\":\"audio/wav\",\"content\":\"$MEETING_WAV_B64\"}" \
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
searchable.

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
  --limit 3 | jq -e '[.results[].content] | join(" ") | test("launch is scheduled")'
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

- **Two agent converters** — an OpenAI vision agent routed to by `image/*` and scanned
  `application/pdf` rules, and an xAI agent (registered as an OpenAI-compatible
  provider) routed to by `audio/*`. Each key is stored as a
  [Secret](/docs/modules/secrets#examples). No JSON Logic, no request mapping: the
  highest-level way to OCR images and transcribe audio.
- **Three ingestion rules** routing `image/*`, `audio/*`, and scanned
  `application/pdf` to those agents, and **fully automatic ingestion** —
  `POST /documents/ingest` never names a converter; the matching rule is resolved from
  `content_type` every time.

Reach for an **agent converter** first — it is the simplest path and keeps credentials
in a secret. When you instead need a dedicated non-LLM API (a specialized OCR/STT
engine) or an async job, SOAT also supports **tool converters** — a plain
[`http` tool](/docs/modules/tools#http) wrapped in a
[`pipeline` tool](/docs/modules/tools#pipeline), including a
[`{ status: "pending" }` async-callback](/docs/modules/ingestion-rules#synchronous-vs-async-callback-conversion)
contract for background jobs. See
[Ingestion Rules — Converter (tool or agent)](/docs/modules/ingestion-rules#converter-tool-or-agent)
for the full contract.

To support another modality (e.g. video), add one rule pointing at an agent — no server
changes, no new deployment, ever. To provision this whole pipeline declaratively
instead of one API call at a time, see
[Deploy a Multi-Agent App with Agent Formation](/docs/tutorials/formations) — the
`ingestion_rule` resource type ([reference](/docs/formations-types/ingestion-rule))
works the same way as every other resource shown there.
