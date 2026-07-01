---
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingest Images and Audio with Converter Tools

Native [file ingestion](/docs/modules/documents#file-ingestion-and-chunking) turns
PDFs and text files into searchable [Documents](/docs/modules/documents#examples).
This tutorial extends it to **images and audio** by routing each unsupported
`content_type` to a converter [Tool](/docs/modules/tools#examples) through an
[Ingestion Rule](/docs/modules/ingestion-rules#examples). The converters call
third-party APIs — [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision)
for image OCR and [xAI speech-to-text](https://docs.x.ai/developers/models/speech-to-text)
for audio transcription — so SOAT itself never has to implement OCR or ASR.

It maps onto the feature's building blocks:

| Building block | Where in this tutorial |
| -------------- | ---------------------- |
| **Converter contract** — how a tool receives the file and returns text | Step 3 |
| **Converter tools** — `http` tools pointing at your adapter | Steps 5–6 |
| **Ingestion rules** — `content_type` → tool routing | Steps 7–9 |
| **Sync conversion** — image OCR inline | Step 10 |
| **Async conversion** — long audio via callback | Step 11 |

:::note Requires the Ingestion Rules feature
The `ingestion-rules` module, the converter step in `POST /documents/ingest`, and
the `POST /documents/:id/ingestion-callback` endpoint are described in
[`docs/prd-file-ingestion.md`](https://github.com/ttoss/soat/blob/main/docs/prd-file-ingestion.md)
and are not yet implemented. Run this tutorial against a server that includes that
change. The API shapes below match the PRD and the
[Ingestion Rules](/docs/modules/ingestion-rules) module docs.
:::

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.
- For production hardening (storing the adapter token as a secret), see
  [Advanced Configuration](/docs/getting-started/advanced-config).
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- An [OpenAI API key](https://platform.openai.com/docs) and an
  [xAI API key](https://docs.x.ai) for the converter adapter.
- A place to run a small HTTP adapter reachable by the SOAT server (any Node host).

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

## Step 3 — Deploy the converter adapter

A converter is any server-callable [Tool](/docs/modules/tools#key-concepts). At
ingest time, SOAT calls the tool with a fixed input and expects text back (the
[converter contract](/docs/modules/ingestion-rules#converter-tool-contract)):

```jsonc
// Input SOAT sends to the tool
{ "file": { "id": "fl_…", "content_type": "image/png",
            "data_base64": "…", "download_url": "…" },
  "callback": { "url": "https://…/ingestion-callback", "token": "…" } }

// Output the tool must return
"extracted text"                                   // one page
{ "pages": [{ "text": "…", "page_number": 1 }] }   // paged
{ "status": "pending" }                            // async — POST result to callback later
```

Third-party APIs like [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision)
and [xAI speech-to-text](https://docs.x.ai/developers/models/speech-to-text) do not
speak this contract, so a bare `http` tool cannot call them directly — a SOAT `http`
tool forwards its input as the JSON body verbatim and returns the raw response. The
adapter is the ~60-line bridge that translates in both directions. Deploy it anywhere
the SOAT server can reach:

```ts
// converter-adapter.ts — run with: OPENAI_API_KEY=… XAI_API_KEY=… \
//   ADAPTER_TOKEN=… XAI_STT_MODEL=… node converter-adapter.ts
import express from 'express';

const app = express();
app.use(express.json({ limit: '25mb' }));

// Shared secret so only SOAT can call the adapter.
app.use((req, res, next) => {
  if (req.get('authorization') !== `Bearer ${process.env.ADAPTER_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ── Image OCR via OpenAI vision (synchronous) ────────────────────────────────
app.post('/ocr', async (req, res) => {
  const { file } = req.body;
  const dataUri = `data:${file.content_type};base64,${file.data_base64}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract all text from this image. Return plain text only.' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    }),
  });
  const json = await r.json();
  const text = json.choices?.[0]?.message?.content ?? '';
  // Return the converter contract: a single page.
  res.json({ pages: [{ text, page_number: 1 }] });
});

// ── Audio transcription via xAI (asynchronous) ───────────────────────────────
app.post('/transcribe', async (req, res) => {
  const { file, callback } = req.body;
  // Long audio can exceed the sync timeout — acknowledge now, deliver via callback.
  res.json({ status: 'pending' });

  (async () => {
    const audio = await fetch(file.download_url).then((x) => x.arrayBuffer());
    const form = new FormData();
    form.append('file', new Blob([audio], { type: file.content_type }), file.filename);
    form.append('model', process.env.XAI_STT_MODEL); // e.g. the STT model from the xAI docs
    const r = await fetch('https://api.x.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
      body: form,
    });
    const { text } = await r.json();
    // Deliver the result to SOAT's callback with the same output contract.
    await fetch(callback.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${callback.token}`,
      },
      body: JSON.stringify({ text }),
    });
  })().catch((err) => console.error('transcription failed', err));
});

app.listen(8787, () => console.log('converter adapter on :8787'));
```

The adapter holds the third-party keys; SOAT only knows the adapter's URL and shared
`ADAPTER_TOKEN`. For the rest of the tutorial, assume it is reachable at
`https://adapter.example.com` and export the shared token:

```bash
export ADAPTER_URL="https://adapter.example.com"
export ADAPTER_TOKEN="choose-a-long-random-string"
```

---

## Step 4 — (Optional) Store the adapter token as a secret

In production, keep the shared token out of the tool definition by storing it as a
[Secret](/docs/modules/secrets#examples) and referencing it from the tool's headers,
rather than pasting it inline as in the next steps.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "ADAPTER_TOKEN" \
  --value "$ADAPTER_TOKEN" | jq '{id: .id, name: .name}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.secrets.createSecret({
  body: { project_id: PROJECT_ID, name: 'ADAPTER_TOKEN', value: process.env.ADAPTER_TOKEN },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"ADAPTER_TOKEN\",\"value\":\"$ADAPTER_TOKEN\"}" \
  | jq '{id: .id, name: .name}'
```

</TabItem>
</Tabs>

---

## Step 5 — Create the image converter tool

An `http` [Tool](/docs/modules/tools#examples) that points at the adapter's `/ocr`
route. SOAT posts the converter input as the request body and returns the adapter's
JSON response.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
OCR_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "openai-vision-ocr" \
  --type "http" \
  --description "Extracts text from an image using OpenAI vision" \
  --execute '{"url":"'"$ADAPTER_URL"'/ocr","method":"POST","headers":{"Authorization":"Bearer '"$ADAPTER_TOKEN"'"}}' \
  | jq -r '.id')
echo "OCR_TOOL_ID: $OCR_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: ocrTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'openai-vision-ocr',
    type: 'http',
    description: 'Extracts text from an image using OpenAI vision',
    execute: {
      url: `${process.env.ADAPTER_URL}/ocr`,
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ADAPTER_TOKEN}` },
    },
  },
});
const OCR_TOOL_ID = ocrTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
OCR_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"openai-vision-ocr\",\"type\":\"http\",\"description\":\"Extracts text from an image using OpenAI vision\",\"execute\":{\"url\":\"$ADAPTER_URL/ocr\",\"method\":\"POST\",\"headers\":{\"Authorization\":\"Bearer $ADAPTER_TOKEN\"}}}" \
  | jq -r '.id')
echo "OCR_TOOL_ID: $OCR_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Create the audio converter tool

Same idea, pointing at `/transcribe`. This tool returns `{ status: "pending" }` and
delivers the transcript to the ingestion callback — see the
[async conversion](/docs/modules/ingestion-rules#synchronous-vs-async-callback-conversion)
concept.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STT_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "xai-speech-to-text" \
  --type "http" \
  --description "Transcribes audio using xAI speech-to-text" \
  --execute '{"url":"'"$ADAPTER_URL"'/transcribe","method":"POST","headers":{"Authorization":"Bearer '"$ADAPTER_TOKEN"'"}}' \
  | jq -r '.id')
echo "STT_TOOL_ID: $STT_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: sttTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-speech-to-text',
    type: 'http',
    description: 'Transcribes audio using xAI speech-to-text',
    execute: {
      url: `${process.env.ADAPTER_URL}/transcribe`,
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ADAPTER_TOKEN}` },
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-speech-to-text\",\"type\":\"http\",\"description\":\"Transcribes audio using xAI speech-to-text\",\"execute\":{\"url\":\"$ADAPTER_URL/transcribe\",\"method\":\"POST\",\"headers\":{\"Authorization\":\"Bearer $ADAPTER_TOKEN\"}}}" \
  | jq -r '.id')
echo "STT_TOOL_ID: $STT_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Route images to the OCR tool

Create an [Ingestion Rule](/docs/modules/ingestion-rules#examples) mapping `image/*`
to the OCR tool. `file_delivery: base64` passes the image bytes inline (fine for
typical images); `chunk_strategy: whole` keeps the extracted text as a single chunk.

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

## Step 8 — Route audio to the transcription tool

Audio files are large and slow to process, so use `file_delivery: download_url` — the
adapter fetches the bytes from a short-lived signed URL instead of receiving base64.
See [file delivery](/docs/modules/ingestion-rules#file-delivery).

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
[content-type matching](/docs/modules/ingestion-rules#content-type-matching). Reusing
the OCR tool makes it a scanned-PDF fallback; born-digital PDFs still skip the converter.

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

## Step 10 — Ingest an image (synchronous)

Upload an image as a [File](/docs/modules/files#examples), then ingest it. Because the
OCR tool returns text directly, `--async false` blocks until the document is `ready` —
the `image/*` rule routed the file through OpenAI vision transparently.

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

## Step 11 — Ingest audio (asynchronous via callback)

Transcription is long-running, so the converter returns `{ status: "pending" }` and the
document stays in `processing` until the adapter POSTs the transcript to the
[ingestion callback](/docs/modules/documents#async-file-ingestion). Ingest with the
default async mode (returns `202`) and poll until `ready`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AUDIO_FILE_ID=$(soat upload-file \
  --project-id "$PROJECT_ID" \
  --file ./meeting.mp3 | jq -r '.id')

DOC_ID=$(soat ingest-document \
  --project-id "$PROJECT_ID" \
  --file-id "$AUDIO_FILE_ID" \
  --path-prefix "/audio/" | jq -r '.id')

# Poll the lightweight status endpoint until the callback completes the document.
while true; do
  STATUS=$(soat get-document-status --document-id "$DOC_ID" | jq -r '.status')
  echo "status: $STATUS"
  [ "$STATUS" = "ready" ] || [ "$STATUS" = "failed" ] && break
  sleep 2
done
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const audioForm = new FormData();
audioForm.append('file', audioBlob, 'meeting.mp3');
audioForm.append('project_id', PROJECT_ID);
const { data: audioFile } = await adminSoat.files.uploadFile({ body: audioForm });

const { data: audioDoc } = await adminSoat.documents.ingestDocument({
  body: { project_id: PROJECT_ID, file_id: audioFile.id, path_prefix: '/audio/' },
});

let status = audioDoc.status;
while (status === 'pending' || status === 'processing') {
  await new Promise((r) => setTimeout(r, 2000));
  const { data } = await adminSoat.documents.getDocumentStatus({
    path: { document_id: audioDoc.id },
  });
  status = data.status;
}
console.log('final status:', status); // "ready"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AUDIO_FILE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/files/upload" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@meeting.mp3" \
  -F "project_id=$PROJECT_ID" | jq -r '.id')

DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/ingest" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"file_id\":\"$AUDIO_FILE_ID\",\"path_prefix\":\"/audio/\"}" \
  | jq -r '.id')

while true; do
  STATUS=$(curl -s "$SOAT_BASE_URL/api/v1/documents/$DOC_ID/status" \
    -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.status')
  echo "status: $STATUS"
  [ "$STATUS" = "ready" ] || [ "$STATUS" = "failed" ] && break
  sleep 2
done
```

</TabItem>
</Tabs>

---

## Step 12 — Search the converted content

Both documents are now chunked and embedded like any other. Query them through the
[Knowledge](/docs/modules/knowledge#examples) layer — the OCR and transcript text is
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

- **A converter adapter** that bridges SOAT's converter contract to
  [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision) and
  [xAI speech-to-text](https://docs.x.ai/developers/models/speech-to-text).
- **Two converter tools** and three **ingestion rules** routing `image/*`, `audio/*`,
  and scanned `application/pdf` to them.
- **Synchronous** image OCR and **asynchronous** audio transcription (via the ingestion
  callback), both landing as searchable Documents.

To support another modality (e.g. video), add a route to the adapter, create one more
`http` tool, and add an ingestion rule for its `content_type` — no server changes
needed. Because converters are just tools, you can swap OpenAI or xAI for any provider
by changing only the adapter.
