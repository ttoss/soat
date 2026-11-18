import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { deleteDocument } from './documents';
import { pathPrefixPattern, type SystemModule, systemPath } from './filePaths';
import { deleteFile } from './files';
import { deleteStorageObjects } from './fileStorage';

const log = createDebug('soat:systemFileRelease');

const RELEASE_BATCH = 50;

/**
 * How each owner's delete releases what its module wrote under `/.system/`.
 * A caller cannot delete those files itself, so a module without an entry
 * would leave them behind. Each release runs once the owner's rows are gone.
 */
export const SYSTEM_FILE_RELEASES = {
  // A fork's messages reference its parent's turn documents, so a document
  // still referenced by a message stays.
  conversations: async (args: { documentIds: number[] }): Promise<void> => {
    const documentIds = [...new Set(args.documentIds)];
    log('conversations: %d documents', documentIds.length);
    for (let start = 0; start < documentIds.length; start += RELEASE_BATCH) {
      const batch = documentIds.slice(start, start + RELEASE_BATCH);
      const referenced = await db.ConversationMessage.findAll({
        where: { documentId: batch },
        attributes: ['documentId'],
      });
      const kept = new Set(
        referenced.map((message) => {
          return message.documentId;
        })
      );
      const released = await db.Document.findAll({
        where: {
          id: batch.filter((id) => {
            return !kept.has(id);
          }),
        },
        attributes: ['publicId'],
      });
      for (const document of released) {
        await deleteDocument({ id: document.publicId });
      }
    }
  },
  // `playbook_exports.file_id` does not take the file with the export.
  playbooks: async (args: {
    projectId: number;
    casePublicId: string;
  }): Promise<void> => {
    const directory = systemPath({
      module: 'playbooks',
      leaf: args.casePublicId,
    });
    log('playbooks: %s', directory);
    const files = await db.File.findAll({
      where: {
        projectId: args.projectId,
        path: { [Op.like]: pathPrefixPattern(directory) },
      },
      attributes: ['publicId'],
    });
    for (const file of files) await deleteFile({ id: file.publicId });
  },
  // The row goes before the object, so no read references bytes mid-delete.
  traces: async (args: { fileIds: number[] }): Promise<void> => {
    log('traces: %d files', args.fileIds.length);
    const files = await db.File.findAll({
      where: { id: args.fileIds },
      attributes: ['storagePath', 'storageType'],
    });
    await db.File.destroy({ where: { id: args.fileIds } });
    await deleteStorageObjects(
      files.map((file) => {
        return { storagePath: file.storagePath, storageType: file.storageType };
      })
    );
  },
} satisfies { [M in SystemModule]: (args: never) => Promise<void> };
