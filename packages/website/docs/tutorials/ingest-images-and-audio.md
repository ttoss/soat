---
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingest Images and Audio with Converters

Native [file ingestion](/docs/modules/documents#file-ingestion-and-chunking) turns
PDFs and text files into searchable [Documents](/docs/modules/documents#examples).
This tutorial extends it to **images and audio** by routing each unsupported
`content_type` to a **converter** through an
[Ingestion Rule](/docs/modules/ingestion-rules#examples).

A converter is a resource you already know:

- **An [Agent](/docs/modules/agents#examples)** with a multimodal model — SOAT feeds
  the file to the model and stores its text output. **Zero plumbing**, and the
  provider key lives in a [Secret](/docs/modules/secrets#examples). This is the
  simplest path, and it is what we use for **images and scanned PDFs**.
- **A [Tool](/docs/modules/tools#examples)** — a plain [`http` tool](/docs/modules/tools#http)
  pointed at a specialized external API, wrapped in a
  [`pipeline` tool](/docs/modules/tools#pipeline) that reshapes the request and
  response with [JSON Logic](https://jsonlogic.com). Use this when you want a
  dedicated OCR/speech-to-text provider or an async job. We use it for **audio**
  (a [Deepgram](https://developers.deepgram.com/docs/pre-recorded-audio)
  speech-to-text call).

Both routes reuse the same chunk + embed pipeline, so the converted text ends up
searchable like any other document, and nothing is hosted outside SOAT either way.

It maps onto the feature's building blocks:

| Building block | Where in this tutorial |
| -------------- | ----------------------- |
| **Agent converter** — a multimodal model does OCR, no plumbing | Part A (Steps 3–8) |
| **`http` + `pipeline` tool converter** — call a dedicated API, reshape with JSON Logic | Part B (Steps 9–11) |
| **Ingestion rules** — `content_type` → converter routing | Steps 6, 7, 11 |
| **Automatic routing** — ingest without naming a converter | Steps 8, 12 |

:::note Requires the Ingestion Rules feature
The `ingestion-rules` module and the converter step in `POST /documents/ingest` are
specified in
[`docs/prd-file-ingestion.md`](https://github.com/ttoss/soat/blob/main/docs/prd-file-ingestion.md)
and are not yet fully implemented (Phase 1 — the data model and lib — has landed; the
REST surface and converter invocation are planned). Run this tutorial against a server
that includes those phases. It is excluded from automated tutorial runs because it
needs external provider keys.
:::

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (storing provider keys as secrets), see
  [Advanced Configuration](/docs/getting-started/advanced-config).
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- An [OpenAI API key](https://platform.openai.com/docs) with access to a **vision**
  model (for the image/PDF agent converter) and a
  [Deepgram API key](https://developers.deepgram.com/docs/pre-recorded-audio) (for the
  audio tool converter). No other infrastructure required.

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1
export OPENAI_API_KEY=sk-...
export DEEPGRAM_API_KEY=...
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

## Part A — Images and scanned PDFs via an agent converter

The simplest converter is an **agent** whose model can read the file. You point an
[Ingestion Rule](/docs/modules/ingestion-rules#converter-tool-or-agent) at the agent
and SOAT sends the file as multimodal input with a fixed "extract all text"
instruction — no request/response mapping to write. For images and scanned PDFs, a
vision model does OCR directly.

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
vision-capable `default_model`, reading its key from the secret above.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "OpenAI Vision" \
  --provider "openai" \
  --default-model "gpt-4o" \
  --secret-id "$OPENAI_SECRET_ID" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: aiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'OpenAI Vision',
    provider: 'openai',
    default_model: 'gpt-4o',
    secret_id: OPENAI_SECRET_ID,
  },
});
const AI_PROVIDER_ID = aiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"OpenAI Vision\",\"provider\":\"openai\",\"default_model\":\"gpt-4o\",\"secret_id\":\"$OPENAI_SECRET_ID\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create the converter agent

Create an [agent](/docs/modules/agents#examples) whose only job is to transcribe what
it sees. The instructions matter most here: keep the model from summarizing or
commenting, so the document text is the raw extracted content.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OCR_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
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
    ai_provider_id: AI_PROVIDER_ID,
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"OCR Agent\",\"instructions\":\"Extract all text from the provided file verbatim. Return plain text only — no commentary, no summary, no markdown fences.\"}" \
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
automatically. That routing hinges on the stored `content_type`, so confirm the upload
recorded `image/png` (set it explicitly via base64 upload if your client does not infer
it).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
IMAGE_FILE_ID=$(soat upload-file \
  --project-id "$PROJECT_ID" \
  --file ./receipt.png | jq -r '.id')

# The stored content_type is what drives routing — confirm it
soat get-file --file-id "$IMAGE_FILE_ID" | jq '{id, content_type}'
# → { "id": "fl_...", "content_type": "image/png" }

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$IMAGE_FILE_ID" \
  --path-prefix "/images/" \
  --async false | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
# → { "id": "doc_...", "status": "ready", "chunk_count": 1 }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const form = new FormData();
form.append('file', imageBlob, 'receipt.png');
form.append('project_id', PROJECT_ID);
const { data: imageFile } = await adminSoat.files.uploadFile({ body: form });

const { data: imageDoc } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: { project_id: PROJECT_ID, file_id: imageFile.id, path_prefix: '/images/' },
});
console.log(imageDoc.status, imageDoc.chunk_count); // "ready" 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
IMAGE_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@receipt.png" \
  -F "project_id=$PROJECT_ID" | jq -r '.id')

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

## Part B — Audio via an `http` + `pipeline` tool converter

When you want a **dedicated** external API rather than a general multimodal model — a
speech-to-text service, a specialized OCR engine, or a long-running async job — use a
**tool** converter. This is where the pipeline's request/response mapping earns its
keep. Before writing it, note the contract both ends of a tool converter must satisfy.

:::info Tool converter contract
Ingestion calls the tool with a fixed **input** and expects a fixed **output** — see
[Ingestion Rules — Converter Tool Contract](/docs/modules/ingestion-rules#converter-tool-contract).

```jsonc
// input (built by ingestion)
{ "file": { "content_type": "…", "data_base64": "…", "download_url": "…" },
  "callback": { "url": "…", "token": "…" } }

// output (returned by the tool)
{ "pages": [{ "text": "…", "page_number": 1 }] }   // or a plain string, or { "status": "pending" }
```

Your `pipeline` tool's only job is to map the provider's request/response shape onto
this contract with JSON Logic — `var` to read a field, `cat` to concatenate.
:::

## Step 9 — Create an `http` tool for Deepgram

An [`http` tool](/docs/modules/tools#http) points `execute.url` directly at
[Deepgram's pre-recorded endpoint](https://developers.deepgram.com/docs/pre-recorded-audio) —
its resolved input becomes the request body and the raw response is returned, no SOAT
endpoint in between.

:::warning Provider key exposure
Unlike AI providers (Step 3), `http` tools do **not** resolve credentials from a
[Secret](/docs/modules/secrets#examples) — the key is stored in the tool's
`execute.headers` and is readable by anyone who can read the tool. Restrict access with
[Policies](/docs/modules/policies#examples) and prefer a scoped, rotatable key.
:::

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DEEPGRAM_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "deepgram-listen" \
  --type "http" \
  --execute '{"url":"https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true","method":"POST","headers":{"Authorization":"Token '"$DEEPGRAM_API_KEY"'","Content-Type":"application/json"}}' \
  | jq -r '.id')
echo "DEEPGRAM_TOOL_ID: $DEEPGRAM_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: deepgramTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'deepgram-listen',
    type: 'http',
    execute: {
      url: 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true',
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  },
});
const DEEPGRAM_TOOL_ID = deepgramTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DEEPGRAM_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"deepgram-listen\",\"type\":\"http\",\"execute\":{\"url\":\"https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true\",\"method\":\"POST\",\"headers\":{\"Authorization\":\"Token $DEEPGRAM_API_KEY\",\"Content-Type\":\"application/json\"}}}" \
  | jq -r '.id')
echo "DEEPGRAM_TOOL_ID: $DEEPGRAM_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 10 — Wrap it in a `pipeline` tool

A [`pipeline` tool](/docs/modules/tools#pipeline) calls the step above and maps between
shapes with [JSON Logic](https://jsonlogic.com): `var` reads the converter's
`file.download_url` into Deepgram's `{ "url": … }` request body, and `var` again
extracts the transcript from Deepgram's response
(`results.channels[0].alternatives[0].transcript`) into the
[converter output contract](/docs/modules/ingestion-rules#converter-tool-contract)
(`{ pages: [...] }`). This is the entire adapter — no server to deploy.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STT_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "deepgram-transcribe" \
  --type "pipeline" \
  --pipeline '{
    "steps": [{
      "id": "call_deepgram",
      "tool_id": "'"$DEEPGRAM_TOOL_ID"'",
      "input": { "url": { "var": "input.file.download_url" } }
    }],
    "output": {
      "pages": [{
        "text": { "var": "steps.call_deepgram.results.channels.0.alternatives.0.transcript" },
        "page_number": 1
      }]
    }
  }' | jq -r '.id')
echo "STT_TOOL_ID: $STT_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sttTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'deepgram-transcribe',
    type: 'pipeline',
    pipeline: {
      steps: [
        {
          id: 'call_deepgram',
          tool_id: DEEPGRAM_TOOL_ID,
          input: { url: { var: 'input.file.download_url' } },
        },
      ],
      output: {
        pages: [
          {
            text: {
              var: 'steps.call_deepgram.results.channels.0.alternatives.0.transcript',
            },
            page_number: 1,
          },
        ],
      },
    },
  },
});
const STT_TOOL_ID = sttTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "deepgram-transcribe",
    "type": "pipeline",
    "pipeline": {
      "steps": [{
        "id": "call_deepgram",
        "tool_id": "'"$DEEPGRAM_TOOL_ID"'",
        "input": { "url": { "var": "input.file.download_url" } }
      }],
      "output": {
        "pages": [{
          "text": { "var": "steps.call_deepgram.results.channels.0.alternatives.0.transcript" },
          "page_number": 1
        }]
      }
    }
  }' | jq -r '.id'
```

</TabItem>
</Tabs>

---

## Step 11 — Route audio to the transcription pipeline

Audio files are larger than typical images, so use `file_delivery: download_url` — the
pipeline's `http` step hands Deepgram a short-lived signed URL to fetch the bytes
itself, instead of loading the whole file into the request as base64. See
[Ingestion Rules — File Delivery](/docs/modules/ingestion-rules#file-delivery). A
transcript is one long block of text, so chunk it with the `size` strategy for sharper
retrieval.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "audio/*" \
  --tool-id "$STT_TOOL_ID" \
  --file-delivery "download_url" \
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
    tool_id: STT_TOOL_ID,
    file_delivery: 'download_url',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"audio/*\",\"tool_id\":\"$STT_TOOL_ID\",\"file_delivery\":\"download_url\",\"chunk_strategy\":\"size\",\"chunk_size\":1000,\"chunk_overlap\":200}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

:::note Long audio
If a recording is long enough that transcription exceeds the sync ingestion timeout,
the converter can instead submit a job and return `{ "status": "pending" }`; the
transcript is delivered later to `POST /api/v1/documents/:id/ingestion-callback` (see
[Ingestion Rules — Synchronous vs Async Conversion](/docs/modules/ingestion-rules#synchronous-vs-async-callback-conversion)).
Deepgram's pre-recorded endpoint returns synchronously for typical lengths, so this
tutorial keeps the sync path.
:::

---

## Step 12 — Ingest audio the same way

Same call shape as the image, different file. The `audio/*` rule from Step 11 routes it
to the transcription pipeline via `POST /documents/ingest` — the caller never names a
tool. See [Documents](/docs/modules/documents#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AUDIO_FILE_ID=$(soat upload-file \
  --project-id "$PROJECT_ID" \
  --file ./meeting.mp3 | jq -r '.id')

soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$AUDIO_FILE_ID" \
  --path-prefix "/audio/" \
  --async false | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const audioForm = new FormData();
audioForm.append('file', audioBlob, 'meeting.mp3');
audioForm.append('project_id', PROJECT_ID);
const { data: audioFile } = await adminSoat.files.uploadFile({ body: audioForm });

const { data: audioDoc } = await adminSoat.documents.ingestDocument({
  query: { async: false },
  body: { project_id: PROJECT_ID, file_id: audioFile.id, path_prefix: '/audio/' },
});
console.log(audioDoc.status, audioDoc.chunk_count);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AUDIO_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@meeting.mp3" \
  -F "project_id=$PROJECT_ID" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/ingest?async=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$AUDIO_FILE_ID\",\"path_prefix\":\"/audio/\"}" \
  | jq '{id: .id, status: .status, chunk_count: .chunk_count}'
```

</TabItem>
</Tabs>

---

## Step 13 — Search the converted content

Both documents are chunked and embedded like any other. Query them through
[Knowledge](/docs/modules/knowledge#examples) — the OCR and transcript text is fully
searchable.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "total amount on the receipt" \
  --document-paths '["/images/"]' \
  --limit 3 | jq '[.results[] | {document_id, score, content}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: search } = await adminSoat.knowledge.searchKnowledge({
  body: {
    project_id: PROJECT_ID,
    query: 'total amount on the receipt',
    document_paths: ['/images/'],
    limit: 3,
  },
});
for (const r of search.results) console.log(r.document_id, r.score);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"total amount on the receipt\",\"document_paths\":[\"/images/\"],\"limit\":3}" \
  | jq '[.results[] | {document_id, score, content}]'
```

</TabItem>
</Tabs>

---

## What you built

- **An agent converter** — a vision agent (its key stored as a
  [Secret](/docs/modules/secrets#examples)) routed to by `image/*` and scanned
  `application/pdf` rules. No JSON Logic, no request mapping: the highest-level way to
  OCR images and scanned PDFs.
- **A tool converter** — a plain [`http` tool](/docs/modules/tools#http) calling
  Deepgram, wrapped in a [`pipeline` tool](/docs/modules/tools#pipeline) that reshapes
  request and response with JSON Logic against the converter contract. The right choice
  when you need a dedicated provider or an async job.
- **Three ingestion rules** routing `image/*`, `audio/*`, and scanned
  `application/pdf` to those converters, and **fully automatic ingestion** —
  `POST /documents/ingest` never names a converter; the matching rule is resolved from
  `content_type` every time.

Reach for an **agent converter** first — it is simpler and keeps credentials in a
secret. Drop to a **tool converter** when you need a specific external API, an async
job, or a provider an agent's model can't reach. To support another modality (e.g.
video), add one rule pointing at an agent, or one `http` + `pipeline` pair — no server
changes, no new deployment, ever.
