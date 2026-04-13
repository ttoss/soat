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

## Operations

### Upload a file

`POST /api/v1/files/upload` — Multipart form-data. The server stores the file on disk and creates a database record.

Required fields: `file` (binary), `projectId`.  
Optional fields: `metadata` (JSON string).

### Download a file

`GET /api/v1/files/{id}/download` — Returns the raw file bytes with the original `Content-Type` and `Content-Disposition: attachment` header.

### Get file metadata

`GET /api/v1/files/{id}` — Returns the file record without transferring the file content.

### Update metadata

`PATCH /api/v1/files/{id}/metadata` — Updates the `metadata` and/or `filename` fields on an existing file record. Both fields are optional; supply at least one.

Request body:

```json
{
  "metadata": "{\"author\":\"Alice\",\"tags\":[\"report\"]}",
  "filename": "new-name.pdf"
}
```

### Delete a file

`DELETE /api/v1/files/{id}` — Removes the file from disk and deletes the database record. Returns `204 No Content`.

### Upload a file (Base64)

`POST /api/v1/files/upload/base64` — JSON-based upload that accepts the file content as a Base64-encoded string. Useful when multipart form-data is not practical (e.g., from MCP tools).

Request body:

```json
{
  "projectId": "proj_xxx",
  "content": "<base64-encoded-bytes>",
  "filename": "report.pdf",
  "contentType": "application/pdf"
}
```

### Download a file (Base64)

`GET /api/v1/files/{id}/download/base64` — Returns the file content as a Base64-encoded JSON response instead of raw bytes. Useful for MCP tool integrations.

Response body:

```json
{
  "content": "<base64-encoded-bytes>",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "size": 12345
}
```

### List files with project filter

`GET /api/v1/files` accepts an optional `projectId` query parameter to filter files by project. When omitted, the server resolves accessible projects based on the caller's identity (same resolution rules as the Documents module).
