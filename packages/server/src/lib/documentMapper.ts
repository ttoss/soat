import type { db } from '../db';

// ── Shared document mapper ───────────────────────────────────────────────

const parseMetadata = (metadata: string | null | undefined): unknown => {
  if (!metadata) return undefined;
  try {
    return JSON.parse(metadata);
  } catch {
    return metadata;
  }
};

type MappableDocument = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

// Extracted so `mapDocument` stays within the complexity budget.
const mapDocumentChunkConfig = (doc: MappableDocument) => {
  return {
    chunkStrategy: doc.chunkStrategy ?? undefined,
    chunkSize: doc.chunkSize ?? undefined,
    chunkOverlap: doc.chunkOverlap ?? undefined,
  };
};

export const mapDocument = (doc: MappableDocument) => {
  return {
    id: doc.publicId,
    fileId: doc.file?.publicId,
    projectId: doc.file?.project?.publicId,
    path: doc.file?.path ?? undefined,
    filename: doc.file?.filename,
    size: doc.file?.size,
    title: doc.title ?? undefined,
    metadata: parseMetadata(doc.metadata),
    tags: doc.tags ?? undefined,
    ...mapDocumentChunkConfig(doc),
    status: doc.status as
      'pending' | 'processing' | 'ready' | 'failed' | undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};
