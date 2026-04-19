import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-files',
    description:
      'List files. If projectId is omitted, returns all files accessible to the caller.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set('projectId', String(args.projectId));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs ? `/files?${qs}` : '/files';
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to filter by' },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        offset: { type: 'number', description: 'Number of results to skip' },
      },
    },
    iamAction: 'files:ListFiles',
  },
  {
    name: 'get-file',
    description: 'Get file metadata by ID',
    method: 'GET',
    path: (args) => {
      return `/files/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
      },
      required: ['id'],
    },
    iamAction: 'files:GetFile',
  },
  {
    name: 'upload-file',
    description:
      'Upload a file encoded in base64. Returns the created file record.',
    method: 'POST',
    path: () => {
      return '/files/upload/base64';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        content: args.content,
        filename: args.filename,
        contentType: args.contentType ?? args.mimeType,
        metadata: args.metadata,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        content: { type: 'string', description: 'Base64-encoded file content' },
        filename: { type: 'string', description: 'Original filename' },
        contentType: {
          type: 'string',
          description: 'MIME type (e.g. image/png)',
        },
        mimeType: {
          type: 'string',
          description: 'Alias for contentType',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata key-value pairs',
        },
      },
      required: ['projectId', 'content'],
    },
    iamAction: 'files:UploadFile',
  },
  {
    name: 'download-file',
    description: 'Download the file content encoded as base64.',
    method: 'GET',
    path: (args) => {
      return `/files/${args.id}/download/base64`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
      },
      required: ['id'],
    },
    iamAction: 'files:DownloadFile',
  },
  {
    name: 'update-file-metadata',
    description: 'Update the metadata or filename of a file.',
    method: 'PATCH',
    path: (args) => {
      return `/files/${args.id}/metadata`;
    },
    body: (args) => {
      return {
        metadata: args.metadata,
        filename: args.filename,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
        metadata: {
          type: 'object',
          description: 'New metadata key-value pairs',
        },
        filename: { type: 'string', description: 'New filename' },
      },
      required: ['id'],
    },
    iamAction: 'files:UpdateFileMetadata',
  },
  {
    name: 'create-file',
    description:
      'Register a file that already exists in a storage backend without uploading content.',
    method: 'POST',
    path: () => {
      return '/files';
    },
    body: (args) => {
      return { ...args };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        storageType: {
          type: 'string',
          enum: ['local', 's3', 'gcs'],
          description: 'Storage backend type',
        },
        storagePath: {
          type: 'string',
          description: 'Path of the file in the storage backend',
        },
        filename: { type: 'string', description: 'Original filename' },
        contentType: { type: 'string', description: 'MIME type' },
        size: { type: 'number', description: 'File size in bytes' },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata key-value pairs',
        },
      },
      required: ['projectId', 'storageType', 'storagePath'],
    },
    iamAction: 'files:CreateFile',
  },
  {
    name: 'delete-file',
    description: 'Delete a file by ID',
    method: 'DELETE',
    path: (args) => {
      return `/files/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
      },
      required: ['id'],
    },
    iamAction: 'files:DeleteFile',
  },
];
