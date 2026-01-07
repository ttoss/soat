# Files Module

The Files module (`@soat/files-core`) provides a flexible file storage and management system with support for multiple storage backends. It handles file uploads, retrieval, deletion, and metadata tracking through a unified interface.

## Overview

The Files module abstracts storage operations across different backends, allowing you to switch between local filesystem, AWS S3, and Google Cloud Storage without changing your application code. It automatically tracks file metadata in PostgreSQL for efficient querying and management.

## Installation

```bash
pnpm add @soat/files-core
```

## Storage Backends

### Local Storage

Store files on the local filesystem.

```typescript
const config: StorageConfig = {
  type: 'local',
  local: {
    path: '/path/to/storage',
  },
};
```

### AWS S3

Store files in Amazon S3 buckets.

```typescript
const config: StorageConfig = {
  type: 's3',
  s3: {
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
};
```

### Google Cloud Storage

Store files in Google Cloud Storage buckets.

```typescript
const config: StorageConfig = {
  type: 'gcs',
  gcs: {
    bucket: 'my-bucket',
    projectId: 'my-project-id',
    keyFilename: '/path/to/service-account-key.json', // optional
  },
};
```

## Core Functions

### saveFile

Save content directly to storage with optional metadata.

```typescript
import { saveFile } from '@soat/files-core';

const file = await saveFile({
  config,
  content: 'Hello, world!', // string or Buffer
  options: {
    contentType: 'text/plain',
    metadata: {
      author: 'John Doe',
      tags: ['greeting', 'example'],
    },
  },
});

console.log(file.id); // UUID of saved file
```

**Parameters:**

- `config`: Storage configuration object
- `content`: String or Buffer containing file data
- `options` (optional):
  - `contentType`: MIME type of the content
  - `metadata`: Key-value pairs for custom metadata

**Returns:** `FileData` object with `id` and `content`

### uploadFile

Upload a file from the local filesystem to storage.

```typescript
import { uploadFile } from '@soat/files-core';

const file = await uploadFile({
  config,
  filePath: '/path/to/local/file.pdf',
  options: {
    contentType: 'application/pdf',
    metadata: {
      filename: 'document.pdf',
      category: 'invoices',
    },
  },
});
```

**Parameters:**

- `config`: Storage configuration object
- `filePath`: Absolute path to the file to upload
- `options` (optional): Same as `saveFile`

**Returns:** `FileData` object with `id` and `content`

### retrieveFileById

Retrieve a file's content by its ID.

```typescript
import { retrieveFileById } from '@soat/files-core';

const file = await retrieveFileById({
  config,
  id: 'file-uuid-here',
});

if (file) {
  console.log(file.content); // Buffer or string
} else {
  console.log('File not found');
}
```

**Parameters:**

- `config`: Storage configuration object
- `id`: UUID of the file to retrieve

**Returns:** `FileData | null`

### deleteFile

Delete a file from both storage and database.

```typescript
import { deleteFile } from '@soat/files-core';

const deleted = await deleteFile({
  config,
  id: 'file-uuid-here',
});

console.log(deleted ? 'File deleted' : 'File not found');
```

**Parameters:**

- `config`: Storage configuration object
- `id`: UUID of the file to delete

**Returns:** `boolean` indicating success

### listFileRecords

List all file records from the database with metadata.

```typescript
import { listFileRecords } from '@soat/files-core';

const files = await listFileRecords();

files.forEach((file) => {
  console.log(file.id, file.filename, file.size, file.createdAt);
});
```

**Returns:** Array of `FileRecord` objects

### getFileRecord

Get a specific file's metadata record.

```typescript
import { getFileRecord } from '@soat/files-core';

const record = await getFileRecord('file-uuid-here');

if (record) {
  console.log(record.filename, record.contentType, record.size);
}
```

**Parameters:**

- `id`: UUID of the file

**Returns:** `FileRecord | null`

## Type Definitions

### StorageConfig

Configuration for storage backend selection.

```typescript
interface StorageConfig {
  type: 'local' | 's3' | 'gcs';
  local?: {
    path: string;
  };
  s3?: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  gcs?: {
    bucket: string;
    keyFilename?: string;
    projectId?: string;
  };
}
```

### UploadOptions

Options for file upload operations.

```typescript
interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, unknown>;
}
```

### FileData

Returned data after file operations.

```typescript
interface FileData {
  id: string;
  content: string | Buffer;
}
```

### FileRecord

Database record for file metadata.

```typescript
interface FileRecord {
  id: string;
  filename?: string;
  contentType?: string;
  size?: number;
  storageType: 'local' | 's3' | 'gcs';
  storagePath: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

## Usage with Server

The Files module is integrated into the SOAT server REST API at `/v1/files`:

- `GET /v1/files` - List all files
- `POST /v1/files/upload` - Upload a file
- `GET /v1/files/:id` - Retrieve file by ID
- `DELETE /v1/files/:id` - Delete file by ID

See the [API documentation](/docs/api/files/soat-files-api) for details.

## Best Practices

### Security

- **Never commit credentials** - Use environment variables for S3/GCS credentials
- **Validate file types** - Check `contentType` before processing
- **Limit file sizes** - Implement size limits at the API level
- **Sanitize metadata** - Validate and sanitize user-provided metadata

### Performance

- **Use buffers for binary data** - More efficient than base64 strings
- **Stream large files** - For files >10MB, consider streaming implementations
- **Cache metadata** - File records are in PostgreSQL, suitable for caching

### Storage Selection

- **Local**: Development, small-scale deployments, low latency requirements
- **S3**: Production, scalable, CDN integration, global availability
- **GCS**: Google Cloud ecosystem, machine learning pipelines

## Error Handling

All functions may throw errors for:

- Invalid configuration
- Storage backend connectivity issues
- Filesystem permission errors
- Database connection failures

Wrap operations in try-catch blocks:

```typescript
try {
  const file = await saveFile({ config, content: data });
  console.log('Saved:', file.id);
} catch (error) {
  console.error('Failed to save file:', error.message);
}
```

## Next Steps

- [Getting Started](/docs/getting-started) - Set up SOAT server with file storage
- [API Reference](/docs/api/files/soat-files-api) - REST API endpoints for files
