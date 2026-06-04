import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Files

The Files module provides file upload, download, metadata management, and deletion through a local filesystem storage backend. Files are stored in a configurable directory and tracked in PostgreSQL.

## Overview

Files are associated with a project and stored on the server's local filesystem. Every file record exposes an `id` — the internal database primary key is never returned.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Debug Session, Generation, and Trace History - Step 6 (Download raw trace steps)](/docs/tutorials/debug-session-generation-trace-history#step-6---download-raw-trace-steps-using-file_id)
- [Orchestrate a Sonnet - Step 8 (Read the persisted poem document)](/docs/tutorials/orchestrate-a-sonnet#step-8--read-the-persisted-poem-document)
- [Permissions in Practice - Step 7 (Verify permissions with file operations)](/docs/tutorials/permissions#step-7--verify-permissions)

## Storage Layout

Files are organized in a **project-scoped** directory structure:

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

If a file has no `path`, the category defaults to `files/`.

Examples:

```
/data/files/proj_1a123a/traces/agt_trace_abc123.json   # trace content
/data/files/proj_1a123a/documents/doc_xyz.md           # document content
/data/files/proj_1a123a/files/file_plain123.png        # file with no path → defaults to files/
```

This layout enables:

- **Project-level cleanup** — delete a project's directory to remove all its files
- **Natural sharding** — categories keep related files together
- **Easy browsing** — directory structure mirrors logical organization

## Configuration

| Environment Variable | Required | Description                                                                                             |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `FILES_STORAGE_DIR`  | Yes      | Absolute path to the directory where uploaded files are stored. Must be writable by the server process. |

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

## Data Model

| Field          | Type                     | Description                                                                                                         |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`           | string                   | Public identifier                                                                                                   |
| `path`         | string \| null           | Logical path within the project (e.g. `/assets/logo.png`). Also used as the resource ID segment in path-based SRNs. |
| `filename`     | string                   | Original filename                                                                                                   |
| `content_type` | string                   | MIME type                                                                                                           |
| `size`         | number                   | File size in bytes                                                                                                  |
| `storage_type` | `local` \| `s3` \| `gcs` | Storage backend (currently `local`)                                                                                 |
| `storage_path` | string                   | Absolute path on disk                                                                                               |
| `metadata`     | string                   | Arbitrary JSON string for custom metadata                                                                           |
| `project_id`   | string                   | ID of the owning project                                                                                            |
| `created_at`   | string                   | ISO 8601 creation timestamp                                                                                         |
| `updated_at`   | string                   | ISO 8601 last-updated timestamp                                                                                     |

### Path Field

The optional `path` field is a logical, project-scoped identifier for a file — similar to a virtual filesystem path. It must be absolute (start with `/`) and is normalized at write time. The combination of `project_id + path` is unique within a project.

Path examples:

```
/assets/logo.png
/exports/2024/report.csv
```

Pass `path` in the upload or create body to set it; the `GET /api/v1/files` list endpoint accepts a `paths` query filter to retrieve files matching specific path prefixes.

### Upsert by Path (Internal)

The server provides an internal `upsertFileByPath` operation used by subsystems (e.g., trace persistence) that need to create or overwrite a file at a known logical path. The behavior:

1. If a file already exists at `(project_id, path)`, its disk content is overwritten and the DB record is updated (size, content type).
2. If no file exists at that path, a new file record is created and written to disk.

This is not exposed as a public REST endpoint — it is an internal building block for modules that store derived data as files (traces, exports, etc.).

## Key Concepts

### Path-Based SRNs

Policies can target files by their logical `path` rather than their `id`. When a file has a `path` set, the server evaluates **both** the id-based SRN and the path-based SRN:

| SRN form                              | Matches                                   |
| ------------------------------------- | ----------------------------------------- |
| `soat:proj_ABC:file:file_XYZ`         | Specific file by ID                       |
| `soat:proj_ABC:file:/assets/logo.png` | File at the exact path `/assets/logo.png` |
| `soat:proj_ABC:file:/exports/*`       | All files under `/exports/`               |
| `soat:proj_ABC:file:*`                | All files in the project (id wildcard)    |

The list endpoint applies policy filters at the SQL level — the database returns only rows the caller is permitted to see.

See the [IAM Reference](iam.md) for full SRN syntax and policy authoring guidance.

## Examples

### Upload a file (base64)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat upload-file-base64 \
  --project-id proj_ABC \
  --filename logo.png \
  --content-base64 "iVBORw0KGgo..." \
  --path /assets/logo.png
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.files.uploadFileBase64({
  body: {
    project_id: 'proj_ABC',
    filename: 'logo.png',
    content_base64: 'iVBORw0KGgo...',
    path: '/assets/logo.png',
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
    "filename": "logo.png",
    "content_base64": "iVBORw0KGgo...",
    "path": "/assets/logo.png"
  }'
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
// SDK
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
