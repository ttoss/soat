import type { db } from '../db';
import { type SoatEventTypeFor } from './eventBus';
import { filenameFromPath, prefixFromPath } from './filePaths';
import { emitLoadedRecordEvent } from './recordEvents';

export const mapFile = (file: InstanceType<(typeof db)['File']>) => {
  return {
    id: file.publicId,
    // `path` is the full key (read-only): `prefix` + `/` + `filename`.
    // `prefix` is its directory, `filename` its leaf / download name.
    // storageType / storagePath are system-managed internals, not exposed.
    prefix: prefixFromPath(file.path),
    filename: file.filename ?? filenameFromPath(file.path),
    path: file.path ?? undefined,
    content_type: file.contentType,
    size: file.size,
    metadata: file.metadata ?? undefined,
    tags: file.tags ?? undefined,
    expires_at: file.expiresAt ?? null,
    delete_after: file.deleteAfter ?? null,
    consumed_by_generation_id: file.consumedByGenerationId ?? null,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
  };
};

/**
 * Emits a file event whose `data` is the file as `GET` answers it, which names
 * its project where `mapFile` alone does not. Mapped from the instance in hand,
 * so a deleted file is announced as it stood.
 */
export const emitFileEvent = (args: {
  type: SoatEventTypeFor<'file'>;
  file: InstanceType<(typeof db)['File']>;
  projectPublicId?: string;
}): Promise<void> => {
  const { file } = args;
  return emitLoadedRecordEvent({
    type: args.type,
    projectId: file.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'file',
    resourceId: file.publicId,
    load: ({ projectPublicId }) => {
      return { ...mapFile(file), project_id: projectPublicId };
    },
  });
};
