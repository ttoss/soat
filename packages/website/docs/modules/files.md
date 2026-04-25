---
sidebar_position: 4
---

# Files

The Files module provides file upload, download, metadata management, and deletion through a local filesystem storage backend. Files are stored in a configurable directory and tracked in PostgreSQL.

## Overview

Files are associated with a project and stored at `{FILES_STORAGE_DIR}/{id}{ext}` on the server's local filesystem. Every file record exposes an `id` — the internal database primary key is never returned.

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

## Permissions

File operations are governed by per-project policies. Grant the following permissions to allow a user to perform each action:

| Action                        | Permission                 | REST Endpoint                      | MCP Tool               |
| ----------------------------- | -------------------------- | ---------------------------------- | ---------------------- |
| List files                    | `files:GetFile`            | `GET /api/v1/files`                | `list-files`           |
| Get file metadata             | `files:GetFile`            | `GET /api/v1/files/:id`            | `get-file`             |
| Create a metadata-only record | `files:CreateFile`         | `POST /api/v1/files`               | `create-file`          |
| Upload a file                 | `files:UploadFile`         | `POST /api/v1/files/upload`        | `upload-file`          |
| Download file content         | `files:DownloadFile`       | `GET /api/v1/files/:id/download`   | `download-file`        |
| Update metadata               | `files:UpdateFileMetadata` | `PATCH /api/v1/files/:id/metadata` | `update-file-metadata` |
| Delete a file                 | `files:DeleteFile`         | `DELETE /api/v1/files/:id`         | `delete-file`          |

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
