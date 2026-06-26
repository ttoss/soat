import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Files

File upload, download, metadata management, and deletion using a local filesystem storage backend.

## Overview

Files are associated with a project and stored on the server's local filesystem. Every file record exposes a public `id`; the internal database primary key is never returned. Files are organized in a project-scoped directory structure and tracked in PostgreSQL.

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

You address a file with two write fields, mirroring an S3 object: a **`prefix`** (the directory, like an S3 prefix — defaults to `/`) and a **`filename`** (the leaf name, like the tail of an S3 key). The server combines them into the read-only **`path`** = `prefix` + `/` + `filename` — the file's full key (akin to an S3 object key). `path` is normalized at write time, and `project_id + path` is unique within a project; it is the file's identity and the target of path-based policy SRNs. To **move** a file, change its `prefix`; to **rename** it, change its `filename` — either rebuilds `path`. Storage backend selection (`local`/`s3`/`gcs`) and the physical on-disk location are system-managed and not exposed through the API — see [Configuration](#configuration).

## Key Concepts

### Storage Layout

Files are organized in a project-scoped directory structure on disk:

```
{FILES_STORAGE_DIR}/{projectPublicId}/{category}/{fileId}{ext}
```

| Segment             | Description                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `FILES_STORAGE_DIR` | Root directory from the environment variable                                                       |
| `projectPublicId`   | Public project ID (e.g. `proj_ABC`) — isolates files by project                                    |
| `category`          | Derived from the first segment of the file's logical `path` (e.g., `/traces/foo.json` → `traces/`) |
| `fileId`            | The file's public ID                                                                               |
| `ext`               | File extension from the original filename                                                          |

If a file has no `path`, the category defaults to `files/`. Examples:

```
/data/files/proj_1a123a/traces/agt_trace_abc123.json
/data/files/proj_1a123a/documents/doc_xyz.md
/data/files/proj_1a123a/files/file_plain123.png
```

Traces persist their raw step payloads as files in the `traces/` category; see it end to end in [Debug Session, Generation, and Trace History - Step 6 (Download raw trace steps)](/docs/tutorials/debug-session-generation-trace-history#step-6---download-raw-trace-steps-using-file_id).

### Path-Based SRNs

Policies can target files by their logical `path` rather than their `id`. When a file has a `path` set, the server evaluates **both** the id-based SRN and the path-based SRN:

| SRN form                              | Matches                                   |
| ------------------------------------- | ----------------------------------------- |
| `soat:proj_ABC:file:file_XYZ`         | Specific file by ID                       |
| `soat:proj_ABC:file:/assets/logo.png` | File at the exact path `/assets/logo.png` |
| `soat:proj_ABC:file:/exports/*`       | All files under `/exports/`               |
| `soat:proj_ABC:file:*`                | All files in the project (id wildcard)    |

The list endpoint applies policy filters at the SQL level — the database returns only rows the caller is permitted to see. See [IAM](./iam.md) for full SRN syntax and policy authoring guidance, or walk through scoping a read-only policy to files in [Permissions in Practice - Step 7 (Verify permissions with file operations)](/docs/tutorials/permissions#step-7--verify-permissions).

### Upload Tokens (decoupled uploads)

Upload tokens provide a two-step upload flow — the local-storage equivalent of an S3 presigned URL — usable from any client (SDK, CLI, curl, or an MCP agent):

1. **Request a token** — `POST /api/v1/files/upload-token` returns a single-use `upload_token`, an `upload_url`, and an `expires_at` (15-minute lifetime). This step is authenticated and requires `files:UploadFile`. By default `upload_url` is **relative** (e.g. `/api/v1/files/upload/upt_xxx`); when the server is configured with `SOAT_BASE_URL`, it is returned as a **fully-qualified absolute URL** so clients and MCP agents can POST to it without knowing the server base URL in advance — see [Configuration](#configuration).
2. **Upload the content** — `POST /api/v1/files/upload/{token}` writes the file and returns the standard file record. This endpoint requires **no bearer credential** — the token is the credential — and accepts either `multipart/form-data` (field `file`) or JSON with a base64 `content` field.

Because the two steps are decoupled, the party that authorizes the upload (step 1) need not be the party that transfers the bytes (step 2) — the token can be handed to a browser, a worker, or a CLI to complete the upload directly over HTTP.

The token is invalidated after a single successful upload. Subsequent uploads return `409`; expired tokens return `410`; unknown tokens return `404`.

#### Large files via MCP

This flow is what makes large uploads possible through MCP. The `upload-file-base64` tool requires the full base64 content as a single tool-call parameter, and payloads larger than ~100 KB are truncated before they reach the agent's tool call. With upload tokens, only step 1 (`create-upload-token`) is exposed as an MCP tool — a small request and a small response that always fit.

The critical part is **step 2 is not an MCP tool**. The agent performs it out-of-band, using whatever non-MCP HTTP capability its runtime provides — **a shell (e.g. `curl`), a `fetch`/HTTP tool, or a direct SDK call**. The bytes travel over plain HTTP and never become a tool-call argument, so the MCP payload limit never applies.

For large files, use `multipart/form-data` and stream the file straight from disk so it is never held as one big in-memory string — do **not** use the base64 `content` field, which would just reintroduce a large payload:

```bash
# Step 1 returned upload_url = /api/v1/files/upload/upt_xxx
curl -F "file=@/path/to/large-report.pdf" "$BASE_URL/api/v1/files/upload/upt_xxx"
```

> An agent whose runtime has **no** out-of-band HTTP path (a pure LLM with only MCP tools and no shell, fetch, or SDK) cannot perform step 2 — but such an agent has no way to move a large file through any mechanism regardless. The token flow assumes the agent can make an ordinary HTTP request outside of MCP.

## Configuration

| Environment Variable | Required | Description                                                                                             |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `FILES_STORAGE_DIR`  | Yes      | Absolute path to the directory where uploaded files are stored. Must be writable by the server process. |
| `SOAT_BASE_URL`      | No       | Public base URL of the server (e.g. `https://api.example.com`). When set, the upload-token flow returns an absolute `upload_url`; otherwise the URL is relative. A trailing slash is trimmed. |

When running via Docker, mount a volume at this path to persist files across container restarts:

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

## Examples

### Upload a file (base64)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat upload-file-base64 \
  --project-id proj_ABC \
  --content-base64 "iVBORw0KGgo..." \
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
    content_base64: 'iVBORw0KGgo...',
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
    "content_base64": "iVBORw0KGgo...",
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
TOKEN=$(soat create-upload-token \
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
const { data: token } = await soat.files.createUploadToken({
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
TOKEN=$(curl -s -X POST https://api.example.com/api/v1/files/upload-token \
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
