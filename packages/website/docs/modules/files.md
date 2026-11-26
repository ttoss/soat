---
description: 'File upload, download, metadata, and deletion over a pluggable storage backend — local filesystem, S3, or GCS.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Files

File upload, download, metadata management, and deletion over a pluggable storage backend (local filesystem, S3, or GCS).

## Overview

Files belong to a project and are persisted through the configured backend (local filesystem, S3, or GCS). Records expose a public `id`, never the internal key; metadata lives in PostgreSQL, while physical location and backend are system-managed (see [Configuration](#configuration)).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Debug Session, Generation, and Trace History - Step 6 (Download raw trace steps)](/docs/tutorials/debug-session-generation-trace-history#step-6---download-raw-trace-steps)
- [Orchestrate a Sonnet - Step 8 (Read the persisted poem document)](/docs/tutorials/orchestrate-a-sonnet#step-8--read-the-persisted-poem-document)
- [Permissions in Practice - Step 7 (Verify permissions with file operations)](/docs/tutorials/permissions#step-7--verify-permissions)

## Data Model

| Field                       | Type           | Description                                                                                                                                                              |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                        | string         | Public identifier                                                                                                                                                        |
| `prefix`                    | string         | Directory within the project (e.g. `/assets`). Optional on write; defaults to `/` (root). Read-only on the record (derived from `path`).                                 |
| `filename`                  | string         | Original / download name and the key's leaf segment (e.g. `logo.png`). Optional on write; defaults to the uploaded file's name.                                          |
| `path`                      | string \| null | **Read-only.** Full key = `prefix` + `/` + `filename` (e.g. `/assets/logo.png`). Unique per project; the file's identity and the resource ID segment in path-based SRNs. |
| `content_type`              | string         | MIME type                                                                                                                                                                |
| `size`                      | number         | File size in bytes                                                                                                                                                       |
| `metadata`                  | object         | Caller-owned annotations, stored as the object they were written as — see [Tags and metadata](iam.md#tags-and-metadata)                                                  |
| `expires_at`                | string \| null | When the file is deleted; `null` never. See [Lifetime](#lifetime)                                                                                                        |
| `delete_after`              | string \| null | `generation`: single use, deleted when the generation that reads it settles. See [Single-use files](#single-use-files)                                                   |
| `consumed_by_generation_id` | string \| null | **Read-only.** The generation that claimed a single-use file; `null` until one does                                                                                      |
| `project_id`                | string         | ID of the owning project. Present on [`GET /files/:id`](/docs/api/files/get-file) and on file events; absent on the other operations' records.                           |
| `created_at`                | string         | ISO 8601 creation timestamp                                                                                                                                              |
| `updated_at`                | string         | ISO 8601 last-updated timestamp                                                                                                                                          |

`path` is normalized at write time, unique per project, and the target of path-based SRNs. Change `prefix` to **move**, `filename` to **rename**; either rebuilds `path`. A collision returns `409 NAME_CONFLICT`. A move or rename of a file that backs a [document](./documents.md) changes that document's `path`, so it removes the project's [content-bound tag keys](./projects.md#content-bound-tag-keys) from the document and emits `documents.updated`. A `..` segment in `prefix` or `filename` returns `400 VALIDATION_FAILED`; a `filename` may nest (`a/b.txt`), and `..` inside a name (`a..b.txt`) is a plain name.

## Key Concepts

### Tags

Key-value string pairs managed via the tag sub-endpoints and matched by `iam:ResourceTag/<key>`. [`GET /api/v1/files`](/docs/api/files/list-files) filters by pair with `?tags=key:value` (repeatable, all must match). See [IAM — Tags](iam.md#tags).

### Metadata

`metadata` is a JSON object, stored as the object it was written as: the types a value was written with are the types a read returns, and keys keep the casing they were supplied in. The platform never reads the bag — [Tags and metadata](iam.md#tags-and-metadata) draws that line — so nothing in it reaches an access decision.

Every surface carries the same object. [`PATCH /api/v1/files/{file_id}/metadata`](/docs/api/files/update-file-metadata) replaces the stored bag, and `null` clears it. A multipart upload is the one exception on the wire, not in the store: a form field carries text, so [`POST /api/v1/files/upload`](/docs/api/files/upload-file) and a multipart [`POST /api/v1/files/upload/{token}`](/docs/api/files/upload-file-with-token) take the object as JSON text and parse it on arrival. Text that is not a JSON object is `400 VALIDATION_FAILED`, as a body field that is not an object is.

### Lifetime

A file written with `expires_in` (seconds) or `expires_at` (a future instant, not with `expires_in`) is deleted when that time comes. Every create route takes them: [`POST /api/v1/files/upload`](/docs/api/files/upload-file) (as form fields), [`POST /api/v1/files/upload/base64`](/docs/api/files/upload-file-base-64), [`POST /api/v1/files`](/docs/api/files/create-file) and [`POST /api/v1/files/presigned-url`](/docs/api/files/create-presigned-url), whose token gives the lifetime to the file it uploads, counted from the upload.

- Past `expires_at`, every read answers `404 RESOURCE_NOT_FOUND` and the file leaves every list; a sweep then deletes its bytes and row and emits `files.deleted`.
- [`PATCH /api/v1/files/{file_id}/metadata`](/docs/api/files/update-file-metadata) only tightens a lifetime: `expires_at` moves earlier or is set on a file that has none, and a past instant expires the file at once. Moving it later or clearing it is `400 VALIDATION_FAILED`.
- A file with a lifetime is never [ingested](./documents.md) (`409 FILE_NOT_INGESTIBLE`), and a file a document is made from is never given one (`409 FILE_HAS_DEPENDENTS`).
- The file counts toward the project's storage until it is deleted.

### Single-use files

`delete_after: "generation"` makes a file single use, for content one generation reads and nothing keeps:

```json
{
  "filename": "exam.pdf",
  "content": "<base64>",
  "content_type": "application/pdf",
  "delete_after": "generation"
}
```

- The first generation that reads it, as a [`file` part](./agents.md#file-parts) or a tool result, claims it (`consumed_by_generation_id`). Another generation naming it is refused with `409 FILE_CONSUMED`.
- It is deleted when that generation completes or fails. A generation paused for an approval or a client tool keeps it, so the turn reads it again when it resumes.
- It always expires: without `expires_in` or `expires_at` it gets `FILE_SINGLE_USE_LIFETIME_SECONDS` (24 hours by default), so a file no generation reads is still deleted.
- It is never a [conversation turn's file](./conversations.md#files-in-a-turn) (`400 VALIDATION_FAILED`), since every later turn would send it again.
- `PATCH` may set `delete_after`, never clear it.

The file is never a document, so nothing it holds reaches [knowledge search](./knowledge.md). For the generation to keep no copy of its content, run it on an agent with [`trace_content_mode: none`](./traces.md#zero-retention-mode).

### Storage Backends

Bytes are handled by a **storage provider** selected with `FILES_STORAGE_PROVIDER` (default `local`); the API is identical across backends. Each file records its backend, so reads and deletes route correctly after the active backend changes.

| Provider           | `FILES_STORAGE_PROVIDER` | Where bytes live                                          |
| ------------------ | ------------------------ | --------------------------------------------------------- |
| Local filesystem   | `local` (default)        | A project-scoped directory tree under `FILES_STORAGE_DIR` |
| S3 / S3-compatible | `s3`                     | Objects in the bucket named by `FILES_S3_BUCKET`          |

Both use the layout `{projectPublicId}/{category}/{fileId}{ext}`:

| Segment           | Description                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `projectPublicId` | Public project ID (e.g. `proj_ABC`) — isolates files by project                                    |
| `category`        | Derived from the first segment of the file's logical `path` (e.g., `/reports/q1.txt` → `reports/`) |
| `fileId`          | The file's public ID                                                                               |
| `ext`             | File extension from the original filename                                                          |

Every writer builds this key the same way. `ext` describes the stored bytes: a [document](/docs/modules/documents)'s text object is always `.txt`.

Without a `path`, the category is `files/`. Local: a path under `FILES_STORAGE_DIR`; S3: the object key, optionally under `FILES_S3_KEY_PREFIX`:

```
# local:   {FILES_STORAGE_DIR}/{projectPublicId}/{category}/{fileId}{ext}
/data/files/proj_1a123a/reports/file_abc123.txt
/data/files/proj_1a123a/documents/doc_xyz.md

# s3:      s3://{FILES_S3_BUCKET}/{FILES_S3_KEY_PREFIX}/{projectPublicId}/{category}/{fileId}{ext}
s3://my-bucket/proj_1a123a/reports/file_abc123.txt
```

### The reserved `/.system/` root

Every module that saves a file or document on your behalf files it under
`/.system/<module>/`, one directory per module:

| Path                                                         | Written by                                      |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `/.system/conversations/{conversation_id}/{document_id}.txt` | Each [conversation](./conversations.md) message |
| `/.system/traces/{trace_id}/{generation_id}/{index}.json`    | Each [trace](./traces.md) step, as it ends      |

The root is yours to read and not to write. A `POST`, a path move or a tag write
that lands under it is refused with `400 RESERVED_PATH`, so the marker cannot be
edited off a row; the owning module deletes what it wrote — deleting a
conversation deletes its turn documents, and so on.

Deleting is the one write that is yours: `DELETE` on a document or file inside
the root is served, so a row whose owner is gone can still be cleared.

A list leaves the root out unless you ask for it: [`GET /api/v1/files`](/docs/api/files/list-files)
and [`GET /api/v1/documents`](/docs/api/documents/list-documents) return
platform-written rows only when `path_prefix` names a directory inside it, and
[knowledge search](./knowledge.md) ranks them only when `document_paths` does.
A read by `id` always returns one. Listing a trace's step files names its
directory: see [Debug Session, Generation, and Trace History - Step 6 (Download raw trace steps)](/docs/tutorials/debug-session-generation-trace-history#step-6---download-raw-trace-steps).

### Path-Based SRNs

Policies can target files by `path`; with a `path` set, **both** the id-based and path-based SRN are evaluated:

| SRN form                             | Matches                                   |
| ------------------------------------ | ----------------------------------------- |
| `srn:proj_ABC:file:file_XYZ`         | Specific file by ID                       |
| `srn:proj_ABC:file:/assets/logo.png` | File at the exact path `/assets/logo.png` |
| `srn:proj_ABC:file:/exports/*`       | All files under `/exports/`               |
| `srn:proj_ABC:file:*`                | All files in the project (id wildcard)    |

List queries apply policy filters in SQL. SRN syntax: [IAM](./iam.md); worked example: [Permissions in Practice - Step 7 (Verify permissions with file operations)](/docs/tutorials/permissions#step-7--verify-permissions).

### Upload Tokens (decoupled uploads)

A two-step flow, the local-storage equivalent of an S3 presigned URL, usable from any client:

1. **Request a token** — [`POST /api/v1/files/presigned-url`](/docs/api/files/create-presigned-url) returns a single-use `upload_token`, `upload_url`, `max_bytes`, `content_type` and `expires_at` (15 minutes). Authenticated; requires `files:UploadFile`. The token fixes where the file lands (`prefix`, `filename`), its byte ceiling (`max_bytes`, by default and at most `FILE_UPLOAD_MAX_BYTES`) and, when `content_type` is given, its type.
2. **Upload the content** — **no bearer credential**; the token is the credential. Either form writes the file and returns the record:
   - [`PUT /api/v1/files/upload/{token}`](/docs/api/files/put-file-with-token): the request body is the file, streamed to storage. It must carry `Content-Length`. This is what a browser sends: `fetch(upload_url, { method: 'PUT', body: file })`.
   - [`POST /api/v1/files/upload/{token}`](/docs/api/files/upload-file-with-token): `multipart/form-data` (field `file`) or JSON with base64 `content`.

The authorizing party (step 1) need not transfer the bytes (step 2): hand the token to a browser, worker, or CLI, and the browser uploads without holding a project credential.

`upload_url` is this server's own route: **relative** (`/api/v1/files/upload/upt_xxx`) unless `SOAT_BASE_URL` is set, then **absolute**. A deployment that serves the route elsewhere, such as a gateway in front of the server, sets `FILES_UPLOAD_URL_TEMPLATE` and every `upload_url` is built from it (see [Configuration](#configuration)).

| Refusal                                                                               | Status | Token afterwards |
| ------------------------------------------------------------------------------------- | ------ | ---------------- |
| Unknown token (`UPLOAD_TOKEN_NOT_FOUND`)                                              | `404`  | —                |
| Already used (`UPLOAD_TOKEN_USED`)                                                    | `409`  | used             |
| Expired (`UPLOAD_TOKEN_EXPIRED`)                                                      | `410`  | expired          |
| `PUT` without `Content-Length` (`UPLOAD_LENGTH_REQUIRED`)                             | `411`  | usable           |
| Over `max_bytes` or the deployment ceiling (`UPLOAD_TOO_LARGE`, `meta.limit`)         | `413`  | usable           |
| Content type other than the token's (`UPLOAD_CONTENT_TYPE_MISMATCH`, `meta.expected`) | `415`  | usable           |

The size and type are checked before the token is consumed, so a refused upload can be retried with the same token. A `PUT` is refused on its `Content-Length` before the body is read. An upload whose body breaks off mid-transfer stores nothing and consumes the token.

### Downloading from a tool

[`GET /api/v1/files/{file_id}/download`](/docs/api/files/download-file) streams raw bytes and is REST/SDK/CLI only (no JSON form, so not an MCP or `builtin` action). Tools use `download-file-base64`, which returns the content base64-encoded in JSON, subject to the client's tool-call payload limit; an agent should fetch large files out-of-band.

#### Large files via MCP

MCP payloads above ~100 KB are truncated, so `upload-file-base64` cannot carry a large file. Use the token flow: `create-presigned-url` (an MCP tool) is small; do step 2 **out-of-band** (`curl`, a `fetch`/HTTP tool, or the SDK) with `multipart/form-data` streamed from disk:

{/* single-client: streamed multipart upload; the CLI and SDK send base64 JSON */}

```bash
# Step 1 returned upload_url = /api/v1/files/upload/upt_xxx
curl -F "file=@/path/to/large-report.pdf" "$BASE_URL/api/v1/files/upload/upt_xxx"
```

## Configuration

| Environment Variable               | Required    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILES_STORAGE_PROVIDER`           | No          | Storage backend: `local` (default) or `s3`. Selects where new files are written.                                                                                                                                                                                                                                                                                                                                                                                            |
| `FILES_STORAGE_DIR`                | For `local` | Absolute path to the directory where uploaded files are stored. Must be writable by the server process. Required when the provider is `local`.                                                                                                                                                                                                                                                                                                                              |
| `FILES_S3_BUCKET`                  | For `s3`    | Name of the S3 bucket that stores file objects. Required when the provider is `s3`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `FILES_S3_REGION`                  | No          | AWS region of the bucket. Falls back to `AWS_REGION` if unset.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FILES_S3_KEY_PREFIX`              | No          | Key prefix prepended to every object, to namespace files within a shared bucket (e.g. `soat/`).                                                                                                                                                                                                                                                                                                                                                                             |
| `FILES_S3_ENDPOINT`                | No          | Custom endpoint URL for S3-compatible stores (e.g. MinIO, Cloudflare R2). Omit for AWS S3.                                                                                                                                                                                                                                                                                                                                                                                  |
| `FILES_S3_FORCE_PATH_STYLE`        | No          | Set to `true` to use path-style bucket addressing (required by some S3-compatible stores).                                                                                                                                                                                                                                                                                                                                                                                  |
| `FILE_UPLOAD_MAX_BYTES`            | No          | Ceiling on an upload, in bytes, and on an upload token's `max_bytes`. Defaults to `26214400` (25 MB). A larger body is refused with `UPLOAD_TOO_LARGE` (`413`) while it is still streaming, so nothing is stored. A multipart upload is spooled to the server's temp directory (a raw-body `PUT` streams straight to the backend) (`TMPDIR`) and streamed to the backend, so memory stays flat and the temp directory needs room for this many bytes per concurrent upload. |
| `FILE_SINGLE_USE_LIFETIME_SECONDS` | No          | Lifetime, in seconds, of a [single-use file](#single-use-files) written without `expires_in` or `expires_at`. Defaults to `86400` (24 hours).                                                                                                                                                                                                                                                                                                                               |
| `FILE_EXPIRY_SWEEP_INTERVAL_MS`    | No          | How often the sweep deletes files past `expires_at`. Defaults to `60000`. Reads already treat such a file as gone.                                                                                                                                                                                                                                                                                                                                                          |
| `FILE_EXPIRY_SWEEP_DISABLED`       | No          | `true` stops the sweep in this process (a fleet where another process runs it).                                                                                                                                                                                                                                                                                                                                                                                             |
| `SOAT_BASE_URL`                    | No          | Public base URL of the server (e.g. `https://api.example.com`). When set, the presigned-URL flow returns an absolute `upload_url`; otherwise the URL is relative. A trailing slash is trimmed.                                                                                                                                                                                                                                                                              |
| `FILES_UPLOAD_URL_TEMPLATE`        | No          | Template every upload token's `upload_url` is built from, for a deployment serving the token route elsewhere (e.g. `https://gateway.example.com/v1/projects/{project_id}/files/upload/{token}`). `{token}` is required, or the server does not boot; `{project_id}` is the token's project. Unset, `upload_url` is this server's own route.                                                                                                                                 |

AWS credentials for `s3` resolve through the standard AWS SDK chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, shared profile, or instance/task role).

With the `local` backend in Docker, mount a volume at `FILES_STORAGE_DIR`:

```yaml
services:
  server:
    image: soat-server
    environment:
      FILES_STORAGE_DIR: /data/files
    volumes:
      - files-data:/data/files

volumes:
  files-data:
```

For S3, set provider and bucket (no volume):

```yaml
services:
  server:
    image: soat-server
    environment:
      FILES_STORAGE_PROVIDER: s3
      FILES_S3_BUCKET: my-soat-files
      FILES_S3_REGION: us-east-1
```

## Examples

### Upload a file (base64)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat upload-file-base64 \
  --project-id proj_ABC \
  --content "iVBORw0KGgo..." \
  --prefix /assets \
  --filename logo.png
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.files.uploadFileBase64({
  body: {
    project_id: 'proj_ABC',
    content: 'iVBORw0KGgo...',
    prefix: '/assets',
    filename: 'logo.png',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/files/upload-base64 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "content": "iVBORw0KGgo...",
    "prefix": "/assets",
    "filename": "logo.png"
  }'
```

</TabItem>
</Tabs>

### Upload a file via an upload token

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Step 1 — request a single-use token
TOKEN=$(soat create-presigned-url \
  --project-id proj_ABC \
  --content-type application/pdf \
  --prefix /documents \
  --filename report.pdf | jq -r .upload_token)

# Step 2 — upload the content directly (no payload limit)
soat upload-file-with-token \
  --token "$TOKEN" \
  --content "$(base64 -w0 report.pdf)"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: token } = await soat.files.createPresignedUrl({
  body: {
    project_id: 'proj_ABC',
    content_type: 'application/pdf',
    prefix: '/documents',
    filename: 'report.pdf',
  },
});

const { data, error } = await soat.files.uploadFileWithToken({
  path: { token: token!.upload_token! },
  body: { content: base64Content },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Step 1 — request a token
TOKEN=$(curl -s -X POST https://api.example.com/api/v1/files/presigned-url \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_ABC","prefix":"/documents","filename":"report.pdf","content_type":"application/pdf","max_bytes":104857600}' | jq -r .upload_token)

# Step 2 — upload the file as the body (token is the credential, no Authorization header)
curl -X PUT "https://api.example.com/api/v1/files/upload/$TOKEN" \
  -H "Content-Type: application/pdf" \
  --data-binary "@report.pdf"
```

</TabItem>
</Tabs>

### List files in a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-files --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.files.listFiles({
  query: { project_id: 'proj_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/files?project_id=proj_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
