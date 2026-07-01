---
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingest Images and Audio with Converter Tools

Native [file ingestion](/docs/modules/documents#file-ingestion-and-chunking) turns
PDFs and text files into searchable [Documents](/docs/modules/documents#examples).
This tutorial extends it to **images and audio** by routing each unsupported
`content_type` to a converter tool through an
[Ingestion Rule](/docs/modules/ingestion-rules#examples). The converters call
third-party APIs — [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision)
for image OCR and [xAI speech-to-text](https://docs.x.ai/developers/models/speech-to-text)
for audio transcription — using **only SOAT-native tools**: a plain
[`http` tool](/docs/modules/tools#http) pointed directly at the provider's API, wrapped
in a [`pipeline` tool](/docs/modules/tools#pipeline) that reshapes the request and
response with [JSON Logic](https://jsonlogic.com). Nothing is hosted outside SOAT.

It maps onto the feature's building blocks:

| Building block | Where in this tutorial |
| -------------- | ----------------------- |
| **`http` step tool** — calls the provider directly | Steps 3, 6 |
| **`pipeline` converter tool** — reshapes request/response via JSON Logic | Steps 4, 7 |
| **Ingestion rules** — `content_type` → tool routing | Steps 5, 8, 9 |
| **Automatic routing** — ingest without passing a tool every time | Steps 10–11 |

:::note Requires the Ingestion Rules feature
The `ingestion-rules` module and the converter step in `POST /documents/ingest` are
described in
[`docs/prd-file-ingestion.md`](https://github.com/ttoss/soat/blob/main/docs/prd-file-ingestion.md)
and are not yet implemented. Run this tutorial against a server that includes that
change. The API shapes below match the PRD and the
[Ingestion Rules](/docs/modules/ingestion-rules) module docs.
:::

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (storing provider keys as secrets), see
  [Advanced Configuration](/docs/getting-started/advanced-config).
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- An [OpenAI API key](https://platform.openai.com/docs) and an
  [xAI API key](https://docs.x.ai) — no other infrastructure required.

```bash
export SOAT_BASE_URL=http://localhost:5047   # CLI, SDK, and curl — do NOT append /api/v1
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

## Step 3 — Create an `http` tool for OpenAI

An [`http` tool](/docs/modules/tools#http) can point `execute.url` directly at any
third-party API — its resolved input is sent as the request body and its raw
response is returned, no SOAT endpoint in between. Store the API key in the tool's
headers (or reference a [secret](/docs/modules/secrets#examples) in production).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OPENAI_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "openai-chat-completions" \
  --type "http" \
  --execute '{"url":"https://api.openai.com/v1/chat/completions","method":"POST","headers":{"Authorization":"Bearer '"$OPENAI_API_KEY"'"}}' \
  | jq -r '.id')
echo "OPENAI_TOOL_ID: $OPENAI_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: openaiTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-chat-completions',
    type: 'http',
    execute: {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    },
  },
});
const OPENAI_TOOL_ID = openaiTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OPENAI_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"openai-chat-completions\",\"type\":\"http\",\"execute\":{\"url\":\"https://api.openai.com/v1/chat/completions\",\"method\":\"POST\",\"headers\":{\"Authorization\":\"Bearer $OPENAI_API_KEY\"}}}" \
  | jq -r '.id')
echo "OPENAI_TOOL_ID: $OPENAI_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Wrap it in a `pipeline` tool that reshapes the request and response

A [`pipeline` tool](/docs/modules/tools#pipeline) calls the step above and maps
between shapes using [JSON Logic](https://jsonlogic.com): `cat` concatenates the
`data:` URI from the converter's `file.content_type` and `file.data_base64`; `var`
extracts `choices[0].message.content` from OpenAI's response into the
[converter output contract](/docs/modules/ingestion-rules#converter-tool-contract)
(`{ pages: [...] }`). This is the entire "adapter" — no server to deploy.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OCR_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "openai-vision-ocr" \
  --type "pipeline" \
  --pipeline '{
    "steps": [{
      "id": "call_openai",
      "tool_id": "'"$OPENAI_TOOL_ID"'",
      "input": {
        "model": "gpt-4o-mini",
        "messages": [{
          "role": "user",
          "content": [
            { "type": "text", "text": "Extract all text from this image. Return plain text only." },
            { "type": "image_url", "image_url": { "url": {
              "cat": ["data:", { "var": "input.file.content_type" }, ";base64,", { "var": "input.file.data_base64" }]
            }}}
          ]
        }]
      }
    }],
    "output": {
      "pages": [{ "text": { "var": "steps.call_openai.choices.0.message.content" }, "page_number": 1 }]
    }
  }' | jq -r '.id')
echo "OCR_TOOL_ID: $OCR_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: ocrTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-vision-ocr',
    type: 'pipeline',
    pipeline: {
      steps: [
        {
          id: 'call_openai',
          tool_id: OPENAI_TOOL_ID,
          input: {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Extract all text from this image. Return plain text only.' },
                  {
                    type: 'image_url',
                    image_url: {
                      url: {
                        cat: ['data:', { var: 'input.file.content_type' }, ';base64,', { var: 'input.file.data_base64' }],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
      output: {
        pages: [{ text: { var: 'steps.call_openai.choices.0.message.content' }, page_number: 1 }],
      },
    },
  },
});
const OCR_TOOL_ID = ocrTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "openai-vision-ocr",
    "type": "pipeline",
    "pipeline": {
      "steps": [{
        "id": "call_openai",
        "tool_id": "'"$OPENAI_TOOL_ID"'",
        "input": {
          "model": "gpt-4o-mini",
          "messages": [{
            "role": "user",
            "content": [
              { "type": "text", "text": "Extract all text from this image. Return plain text only." },
              { "type": "image_url", "image_url": { "url": {
                "cat": ["data:", { "var": "input.file.content_type" }, ";base64,", { "var": "input.file.data_base64" }]
              }}}
            ]
          }]
        }
      }],
      "output": {
        "pages": [{ "text": { "var": "steps.call_openai.choices.0.message.content" }, "page_number": 1 }]
      }
    }
  }' | jq -r '.id'
```

</TabItem>
</Tabs>

---

## Step 5 — Route images to the OCR pipeline tool

Create an [Ingestion Rule](/docs/modules/ingestion-rules#examples) mapping `image/*`
to the pipeline tool — the same converter mechanism regardless of whether `tool_id`
points at a plain `http` tool or a `pipeline` tool.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "image/*" \
  --tool-id "$OCR_TOOL_ID" \
  --file-delivery "base64" \
  --chunk-strategy "whole" | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.ingestionRules.createIngestionRule({
  body: {
    project_id: PROJECT_ID,
    content_type_glob: 'image/*',
    tool_id: OCR_TOOL_ID,
    file_delivery: 'base64',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"image/*\",\"tool_id\":\"$OCR_TOOL_ID\",\"file_delivery\":\"base64\",\"chunk_strategy\":\"whole\"}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

---

## Step 6 — Create an `http` tool for xAI

Same pattern for transcription: an `http` tool pointed at xAI's speech-to-text
endpoint. Like OpenAI's Whisper API, a single request returns the transcript
directly in the response for typical audio lengths — no job polling needed.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
XAI_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "xai-speech-to-text" \
  --type "http" \
  --execute '{"url":"https://api.x.ai/v1/audio/transcriptions","method":"POST","headers":{"Authorization":"Bearer '"$XAI_API_KEY"'"}}' \
  | jq -r '.id')
echo "XAI_TOOL_ID: $XAI_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: xaiTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-speech-to-text',
    type: 'http',
    execute: {
      url: 'https://api.x.ai/v1/audio/transcriptions',
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    },
  },
});
const XAI_TOOL_ID = xaiTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
XAI_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-speech-to-text\",\"type\":\"http\",\"execute\":{\"url\":\"https://api.x.ai/v1/audio/transcriptions\",\"method\":\"POST\",\"headers\":{\"Authorization\":\"Bearer $XAI_API_KEY\"}}}" \
  | jq -r '.id')
echo "XAI_TOOL_ID: $XAI_TOOL_ID"
```

</TabItem>
</Tabs>

:::note Long audio
If a recording is long enough that transcription exceeds the sync ingestion
timeout, the converter can instead submit a job and return
`{ "status": "pending" }`; the transcript is then delivered later to
`POST /api/v1/documents/:id/ingestion-callback` (see
[Ingestion Rules — Synchronous vs Async Conversion](/docs/modules/ingestion-rules#synchronous-vs-async-callback-conversion)).
That still needs no server of your own — whatever completes the job (a script, a
provider-side webhook) makes one authenticated POST back to SOAT.
:::

---

## Step 7 — Wrap it in a `pipeline` tool

Map the converter's `file.download_url` into xAI's request and extract the
transcript into the `{ pages: [...] }` contract.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STT_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "xai-transcribe" \
  --type "pipeline" \
  --pipeline '{
    "steps": [{
      "id": "call_xai",
      "tool_id": "'"$XAI_TOOL_ID"'",
      "input": {
        "model": "whisper-1",
        "file_url": { "var": "input.file.download_url" }
      }
    }],
    "output": {
      "pages": [{ "text": { "var": "steps.call_xai.text" }, "page_number": 1 }]
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
    name: 'xai-transcribe',
    type: 'pipeline',
    pipeline: {
      steps: [
        {
          id: 'call_xai',
          tool_id: XAI_TOOL_ID,
          input: { model: 'whisper-1', file_url: { var: 'input.file.download_url' } },
        },
      ],
      output: { pages: [{ text: { var: 'steps.call_xai.text' }, page_number: 1 }] },
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
    "name": "xai-transcribe",
    "type": "pipeline",
    "pipeline": {
      "steps": [{
        "id": "call_xai",
        "tool_id": "'"$XAI_TOOL_ID"'",
        "input": { "model": "whisper-1", "file_url": { "var": "input.file.download_url" } }
      }],
      "output": { "pages": [{ "text": { "var": "steps.call_xai.text" }, "page_number": 1 }] }
    }
  }' | jq -r '.id'
```

</TabItem>
</Tabs>

---

## Step 8 — Route audio to the transcription pipeline

Audio files are larger than typical images, so use `file_delivery: download_url` —
the pipeline's `http` step fetches the bytes itself instead of receiving base64. See
[Ingestion Rules — File Delivery](/docs/modules/ingestion-rules#file-delivery).

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

---

## Step 9 — (Optional) OCR fallback for scanned PDFs

A scanned PDF has `content_type: application/pdf` but no text layer, so the native
parser yields nothing. A rule matching `application/pdf` is used **only when native
extraction returns no text** — see
[Ingestion Rules — Content-Type Matching](/docs/modules/ingestion-rules#content-type-matching).
Reusing the OCR pipeline tool makes it a scanned-PDF fallback; born-digital PDFs
still skip the converter.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id "$PROJECT_ID" \
  --content-type-glob "application/pdf" \
  --tool-id "$OCR_TOOL_ID" \
  --file-delivery "base64" \
  --chunk-strategy "whole" | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.ingestionRules.createIngestionRule({
  body: {
    project_id: PROJECT_ID,
    content_type_glob: 'application/pdf',
    tool_id: OCR_TOOL_ID,
    file_delivery: 'base64',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"content_type_glob\":\"application/pdf\",\"tool_id\":\"$OCR_TOOL_ID\",\"file_delivery\":\"base64\",\"chunk_strategy\":\"whole\"}" \
  | jq '{id: .id, content_type_glob: .content_type_glob}'
```

</TabItem>
</Tabs>

---

## Step 10 — Ingest an image without specifying a converter

Upload an image as a [File](/docs/modules/files#examples), then ingest it exactly
like a PDF or text file. Nothing about the call names OpenAI, the pipeline, or the
rule — `POST /documents/ingest` resolves the matching rule from `content_type`
automatically, every time, for every future image.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
IMAGE_FILE_ID=$(soat upload-file \
  --project-id "$PROJECT_ID" \
  --file ./receipt.png | jq -r '.id')

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

---

## Step 11 — Ingest audio the same way

Same call shape, different file. The `audio/*` rule from Step 8 routes it to the
transcription pipeline — the caller never names a tool.

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

## Step 12 — Search the converted content

Both documents are chunked and embedded like any other. Query them through
[Knowledge](/docs/modules/knowledge#examples) — the OCR and transcript text is
fully searchable.

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

- **Two converters**, each a plain [`http` tool](/docs/modules/tools#http) calling
  OpenAI/xAI directly, wrapped in a [`pipeline` tool](/docs/modules/tools#pipeline)
  that reshapes request and response with JSON Logic. No adapter server, no code
  outside SOAT.
- **Three ingestion rules** routing `image/*`, `audio/*`, and scanned
  `application/pdf` to those converters.
- **Fully automatic ingestion** — `POST /documents/ingest` never names a tool; the
  matching rule is resolved from `content_type` every time.

To support another modality (e.g. video) or swap providers, add one `http` tool, one
`pipeline` tool with the right JSON Logic mapping, and one ingestion rule — no server
changes, no new deployment, ever.
