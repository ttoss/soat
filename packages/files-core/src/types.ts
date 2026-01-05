export interface StorageConfig {
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

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface FileData {
  id: string;
  content: string | Buffer;
}

export interface FileRecord {
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
