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
    chunk_strategy: doc.chunkStrategy ?? undefined,
    chunk_size: doc.chunkSize ?? undefined,
    chunk_overlap: doc.chunkOverlap ?? undefined,
  };
};

// The fields a document borrows from its backing file. Extracted, like the
// chunk config below, to keep `mapDocument` within the complexity budget.
const mapDocumentFileFields = (doc: MappableDocument) => {
  return {
    file_id: doc.file?.publicId,
    project_id: doc.file?.project?.publicId,
    path: doc.file?.path ?? undefined,
    filename: doc.file?.filename,
    // The source file's media type, echoed so a caller can tell a PDF from a
    // transcript without also fetching the file (#1041).
    content_type: doc.file?.contentType ?? undefined,
    size: doc.file?.size,
  };
};

export const mapDocument = (doc: MappableDocument) => {
  return {
    id: doc.publicId,
    ...mapDocumentFileFields(doc),
    title: doc.title ?? undefined,
    metadata: parseMetadata(doc.metadata),
    tags: doc.tags ?? undefined,
    ...mapDocumentChunkConfig(doc),
    status: doc.status as
      'pending' | 'processing' | 'ready' | 'failed' | undefined,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
};
