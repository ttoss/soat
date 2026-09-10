---
description: "File upload, download, metadata, and deletion over a pluggable storage backend — local filesystem, S3, or GCS."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Files

File upload, download, metadata management, and deletion over a pluggable storage backend (local filesystem, S3, or GCS).

## Overview

Files belong to a project and are persisted through the configured backend (local filesystem, S3, or GCS). Records expose a public `id`, never the internal key; metadata lives in PostgreSQL, while physical location and backend are system-managed (see [Configuration](#configuration)).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Debug Session, Generation, and Trace History - Step 6 (Download raw trace steps)](/docs/tutorials/debug-session-generation-trace-history#step-6---download-raw-trace-steps-using-file_id)
- [Orchestrate a Sonnet - Step 8 (Read the persisted poem document)](/docs/tutorials/orchestrate-a-sonnet#step-8--read-the-persisted-poem-document)
- [Permissions in Practice - Step 7 (Verify permissions with file operations)](/docs/tutorials/permissions#step-7--verify-permissions)

## Data Model

| Field          | Type                     | Description                                                                                                         |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`           | string                   | Public identifier                                                                                                   |
| `prefix`       | string                   | Directory within the project (e.g. `/assets`). Optional on write; defaults to `/` (root). Read-only on the record (derived from `path`). |
| `filename`     | string                   | Original / download name and the key's leaf segment (e.g. `logo.png`). Optional on write; defaults to the uploaded file's name. |
| `path`         | string \| null           | **Read-only.** Full key = `prefix` + `/` + `filename` (e.g. `/assets/logo.png`). Unique per project; the file's identity and the resource ID segment in path-based SRNs. |
| `content_type` | string                   | MIME type                                                                                                           |
| `size`         | number                   | File size in bytes                                                                                                  |
| `metadata`     | string                   | Arbitrary JSON string for custom metadata                                                                           |
| `project_id`   | string                   | ID of the owning project                                                                                            |
| `created_at`   | string                   | ISO 8601 creation timestamp                                                                                         |
| `updated_at`   | string                   | ISO 8601 last-updated timestamp                                                                                     |

`path` is normalized at write time, unique per project, and the target of path-based SRNs. Change `prefix` to **move**, `filename` to **rename**; either rebuilds `path`. A collision returns `409 NAME_CONFLICT`.

## Key Concepts

### Storage Backends

Bytes are handled by a **storage provider** selected with `FILES_STORAGE_PROVIDER` (default `local`); the API is identical across backends. Each file records its backend, so reads and deletes route correctly after the active backend changes.

| Provider | `FILES_STORAGE_PROVIDER` | Where bytes live |
| -------- | ------------------------ | ---------------- |
| Local filesystem | `local` (default) | A project-scoped directory tree under `FILES_STORAGE_DIR` |
| S3 / S3-compatible | `s3` | Objects in the bucket named by `FILES_S3_BUCKET` |

Both use the layout `{projectPublicId}/{category}/{fileId}{ext}`:

| Segment           | Description                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `projectPublicId` | Public project ID (e.g. `proj_ABC`) — isolates files by project                                    |
| `category`        | Derived from the first segment of the file's logical `path` (e.g., `/traces/foo.json` → `traces/`) |
| `fileId`          | The file's public ID                                                                               |
| `ext`             | File extension from the original filename                                                          |

Every writer builds this key the same way. `ext` describes the stored bytes: a [document](/docs/modules/documents)'s text object is always `.txt`.

Without a `path`, the category is `files/`. Local: a path under `FILES_STORAGE_DIR`; S3: the object key, optionally under `FILES_S3_KEY_PREFIX`:

```
# local:   {FILES_STORAGE_DIR}/{projectPublicId}/{category}/{fileId}{ext}
/data/files/proj_1a123a/traces/trace_abc123.json
/data/files/proj_1a123a/documents/doc_xyz.md

# s3:      s3://{FILES_S3_BUCKET}/{FILES_S3_KEY_PREFIX}/{projectPublicId}/{category}/{fileId}{ext}
s3://my-bucket/proj_1a123a/traces/trace_abc123.json
```

Traces persist raw steps in `traces/`; see [Debug Session, Generation, and Trace History - Step 6 (Download raw trace steps)](/docs/tutorials/debug-session-generation-trace-history#step-6---download-raw-trace-steps-using-file_id).

### Path-Based SRNs

Policies can target files by `path`; with a `path` set, **both** the id-based and path-based SRN are evaluated:

| SRN form                              | Matches                                   |
| ------------------------------------- | ----------------------------------------- |
| `srn:proj_ABC:file:file_XYZ`         | Specific file by ID                       |
| `srn:proj_ABC:file:/assets/logo.png` | File at the exact path `/assets/logo.png` |
| `srn:proj_ABC:file:/exports/*`       | All files under `/exports/`               |
| `srn:proj_ABC:file:*`                | All files in the project (id wildcard)    |

List queries apply policy filters in SQL. SRN syntax: [IAM](./iam.md); worked example: [Permissions in Practice - Step 7 (Verify permissions with file operations)](/docs/tutorials/permissions#step-7--verify-permissions).

### Upload Tokens (decoupled uploads)

A two-step flow, the local-storage equivalent of an S3 presigned URL, usable from any client:

1. **Request a token** — [`POST /api/v1/files/presigned-url`](/docs/api/files/create-presigned-url) returns a single-use `upload_token`, `upload_url`, and `expires_at` (15 minutes). Authenticated; requires `files:UploadFile`. `upload_url` is **relative** (e.g. `/api/v1/files/upload/upt_xxx`) unless `SOAT_BASE_URL` is set, in which case it is **absolute** (see [Configuration](#configuration)).
2. **Upload the content** — [`POST /api/v1/files/upload/{token}`](/docs/api/files/upload-file-with-token) writes the file and returns the record. **No bearer credential**; the token is the credential. Accepts `multipart/form-data` (field `file`) or JSON with base64 `content`.

The authorizing party (step 1) need not transfer the bytes (step 2): hand the token to a browser, worker, or CLI.

A token is invalidated after one successful upload: reuse `409`, expired `410`, unknown `404`.

### Downloading from a tool

[`GET /api/v1/files/{file_id}/download`](/docs/api/files/download-file) streams raw bytes and is REST/SDK/CLI only (no JSON form, so not an MCP or `builtin` action). Tools use `download-file-base64`, which returns the content base64-encoded in JSON, subject to the client's tool-call payload limit; an agent should fetch large files out-of-band.

#### Large files via MCP

MCP payloads above ~100 KB are truncated, so `upload-file-base64` cannot carry a large file. Use the token flow: `create-presigned-url` (an MCP tool) is small; do step 2 **out-of-band** (`curl`, a `fetch`/HTTP tool, or the SDK) with `multipart/form-data` streamed from disk:

```bash
# Step 1 returned upload_url = /api/v1/files/upload/upt_xxx
curl -F "file=@/path/to/large-report.pdf" "$BASE_URL/api/v1/files/upload/upt_xxx"
```

## Configuration

| Environment Variable | Required | Description                                                                                             |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `FILES_STORAGE_PROVIDER` | No   | Storage backend: `local` (default) or `s3`. Selects where new files are written. |
| `FILES_STORAGE_DIR`  | For `local` | Absolute path to the directory where uploaded files are stored. Must be writable by the server process. Required when the provider is `local`. |
| `FILES_S3_BUCKET`    | For `s3` | Name of the S3 bucket that stores file objects. Required when the provider is `s3`. |
| `FILES_S3_REGION`    | No       | AWS region of the bucket. Falls back to `AWS_REGION` if unset. |
| `FILES_S3_KEY_PREFIX` | No      | Key prefix prepended to every object, to namespace files within a shared bucket (e.g. `soat/`). |
| `FILES_S3_ENDPOINT`  | No       | Custom endpoint URL for S3-compatible stores (e.g. MinIO, Cloudflare R2). Omit for AWS S3. |
| `FILES_S3_FORCE_PATH_STYLE` | No | Set to `true` to use path-style bucket addressing (required by some S3-compatible stores). |
| `FILE_UPLOAD_MAX_BYTES` | No    | Ceiling on a multipart upload, in bytes. Defaults to `26214400` (25 MB). A larger body is refused with `UPLOAD_TOO_LARGE` (`413`) while it is still streaming, so nothing is buffered or stored. |
| `SOAT_BASE_URL`      | No       | Public base URL of the server (e.g. `https://api.example.com`). When set, the presigned-URL flow returns an absolute `upload_url`; otherwise the URL is relative. A trailing slash is trimmed. |

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
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

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
  -d '{"project_id":"proj_ABC","prefix":"/documents","filename":"report.pdf"}' | jq -r .upload_token)

# Step 2 — upload the file (token is the credential, no Authorization header)
curl -X POST "https://api.example.com/api/v1/files/upload/$TOKEN" \
  -F "file=@report.pdf"
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
