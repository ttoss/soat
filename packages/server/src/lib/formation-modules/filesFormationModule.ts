import { createFile, deleteFile, getFile, updateFileMetadata } from '../files';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const filesFormationModule = defineFormationModule({
  resourceType: 'file',

  // storage_type / storage_path are not part of the file resource schema —
  // storage is system-managed (see FILES_STORAGE_DIR).
  create: ({ properties, projectId }) => {
    return createFile({
      projectId,
      prefix: toOptionalString(properties.prefix) ?? undefined,
      filename: toOptionalString(properties.filename) ?? undefined,
      contentType: toOptionalString(properties.content_type) ?? undefined,
      size: typeof properties.size === 'number' ? properties.size : undefined,
      metadata: toOptionalString(properties.metadata) ?? undefined,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateFileMetadata({
      id: physicalResourceId,
      prefix: toOptionalString(properties.prefix) ?? undefined,
      filename: toOptionalString(properties.filename) ?? undefined,
      metadata: toOptionalString(properties.metadata) ?? undefined,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteFile({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getFile({ id: physicalResourceId });
  },
});
