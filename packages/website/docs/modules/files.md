# Files Module

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

| Field         | Type                     | Description                               |
| ------------- | ------------------------ | ----------------------------------------- |
| `id`          | string                   | Public identifier                         |
| `filename`    | string                   | Original filename                         |
| `contentType` | string                   | MIME type                                 |
| `size`        | number                   | File size in bytes                        |
| `storageType` | `local` \| `s3` \| `gcs` | Storage backend (currently `local`)       |
| `storagePath` | string                   | Absolute path on disk                     |
| `metadata`    | string                   | Arbitrary JSON string for custom metadata |
| `projectId`   | string                   | ID of the owning project                  |
| `createdAt`   | string                   | ISO 8601 creation timestamp               |
| `updatedAt`   | string                   | ISO 8601 last-updated timestamp           |

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

See the [API Reference](../api/files/list-files) for full endpoint details, request/response schemas, and status codes.
