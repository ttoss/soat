# Files Module

The Files module provides file upload, download, metadata management, and deletion through a local filesystem storage backend. Files are stored in a configurable directory and tracked in PostgreSQL.

## Overview

Files are associated with a project and stored at `{FILES_STORAGE_DIR}/{publicId}{ext}` on the server's local filesystem. Every file record exposes a `publicId` as its `id` — the internal database primary key is never returned.

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

| Field         | Type                     | Description                                                        |
| ------------- | ------------------------ | ------------------------------------------------------------------ |
| `id`          | string                   | Public identifier (exposed as `id`, maps to `publicId` internally) |
| `filename`    | string                   | Original filename                                                  |
| `contentType` | string                   | MIME type                                                          |
| `size`        | number                   | File size in bytes                                                 |
| `storageType` | `local` \| `s3` \| `gcs` | Storage backend (currently `local`)                                |
| `storagePath` | string                   | Absolute path on disk                                              |
| `metadata`    | string                   | Arbitrary JSON string for custom metadata                          |
| `projectId`   | string                   | ID of the owning project                                           |
| `createdAt`   | string                   | ISO 8601 creation timestamp                                        |
| `updatedAt`   | string                   | ISO 8601 last-updated timestamp                                    |

## Permissions

File operations are governed by per-project policies. Grant the following permissions to allow a user to perform each action:

| Action                        | Permission string          |
| ----------------------------- | -------------------------- |
| Upload a file                 | `files:UploadFile`         |
| Get file metadata             | `files:GetFile`            |
| Download file content         | `files:DownloadFile`       |
| Update metadata               | `files:UpdateFileMetadata` |
| Create a metadata-only record | `files:CreateFile`         |
| Delete a file                 | `files:DeleteFile`         |

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

`PATCH /api/v1/files/{id}/metadata` — Replaces the `metadata` field on an existing file record.

Request body:

```json
{ "metadata": "{\"author\":\"Alice\",\"tags\":[\"report\"]}" }
```

### Delete a file

`DELETE /api/v1/files/{id}` — Removes the file from disk and deletes the database record. Returns `204 No Content`.
