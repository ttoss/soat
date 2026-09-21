import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { mapDocument } from './documentMapper';
import {
  buildWithdrawnConfigSnapshot,
  documentVersionStore,
} from './documentVersionSnapshot';
import { emitResourceEvent } from './eventBus';
import { assertCallerPath } from './filePaths';
import { toResourceRef } from './resourceVersions';
import { WITHDRAWN_STATUS } from './systemPathScope';
import type { VersionedWrite } from './writePrecondition';

const log = createDebug('soat:documents');

/**
 * Withdrawing a document, and bringing it back.
 *
 * A withdrawal is a version, not a `deleted_at`. Versions already answer what
 * a document holds now, so making withdrawal one of them means there is a
 * single lifecycle mechanism: the tombstone version says when the document
 * left and who took it out, the version before it says what to bring back, and
 * no reader has to learn a second exclusion.
 *
 * `DELETE` stays what it is — permanent, with the backing file removed. A
 * withdrawal is the reversible act, and it keeps the record.
 */

type LoadedDoc = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

const loadDocument = (publicId: string): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { publicId },
    include: [
      {
        model: db.File,
        as: 'file',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  }) as Promise<LoadedDoc | null>;
};

/**
 * Takes a document out of every default read, keeping its history.
 *
 * Its chunks go with it. That is what keeps knowledge search's recall intact:
 * an exclusion evaluated inside the vector scan spends the scan's budget on
 * rows it then discards, and a corpus where withdrawals are common is exactly
 * where that budget runs out and the search quietly returns short. With no
 * vectors in the index there is nothing to discard, so a withdrawal costs a
 * live search nothing at all.
 *
 * The content is not lost with them: it is in the version before the
 * tombstone, which is what {@link restoreDocumentVersion} re-chunks from.
 */
export const withdrawDocument = async (
  args: { id: string } & VersionedWrite
) => {
  log('withdrawDocument: id=%s', args.id);

  const doc = await loadDocument(args.id);
  if (!doc) return null;

  // Platform-written documents keep the owning module's lifecycle: a trace or
  // a conversation turn is that module's record, and withdrawing it would take
  // a row out from under the module that reads it.
  assertCallerPath(doc.file?.path);

  if (doc.status === WITHDRAWN_STATUS) {
    throw new DomainError(
      'DOCUMENT_ALREADY_WITHDRAWN',
      `Document '${args.id}' is already withdrawn.`,
      { document_id: args.id }
    );
  }

  await documentVersionStore.commitConfigChange({
    resource: toResourceRef(doc),
    expectedVersion: args.expectedVersion,
    before: { withdrawn: false },
    label: args.versionLabel ?? 'withdrawn',
    createdByUserId: args.createdByUserId,
    applyWrite: async ({ transaction }) => {
      await doc.update({ status: WITHDRAWN_STATUS }, { transaction });
      await db.DocumentChunk.destroy({
        where: { documentId: doc.id as number },
        transaction,
      });
      return { row: doc, after: buildWithdrawnConfigSnapshot() };
    },
  });

  const mapped = mapDocument(doc);

  emitResourceEvent({
    type: 'documents.withdrawn',
    projectId: doc.file?.project?.id as number,
    projectPublicId: doc.file?.project?.publicId,
    resourceType: 'document',
    resourceId: doc.publicId,
    data: mapped,
  });

  return mapped;
};

/**
 * The version a restore brings back when the caller names none: the last one
 * that held content.
 *
 * A withdrawal is followed by nothing, so it is always the tombstone's
 * predecessor — but it is read rather than computed, because a document may be
 * withdrawn, restored and withdrawn again, and `version - 1` would then name
 * whichever of those the arithmetic landed on.
 */
export const lastContentVersion = async (args: {
  documentDbId: number;
}): Promise<number | null> => {
  const rows = await documentVersionStore.versionModel().findAll({
    where: { documentId: args.documentDbId },
    order: [['version', 'DESC']],
    limit: 2,
  });

  const previous = rows.find((row) => {
    return !(row.config as Record<string, unknown>).withdrawn;
  });

  return previous?.version ?? null;
};

/** Whether the document's current version is a tombstone. */
export const isWithdrawn = async (args: {
  documentDbId: number;
}): Promise<boolean> => {
  const document = await db.Document.findOne({
    where: { id: args.documentDbId },
    attributes: ['status'],
  });
  return document?.status === WITHDRAWN_STATUS;
};

/**
 * Marks a withdrawn document live again once its content has been restored.
 *
 * Called by the restore path rather than exposed on its own: a document whose
 * status said `ready` while its chunks were still gone would be listed and
 * searched as though it had content.
 */
export const clearWithdrawnStatus = async (args: {
  documentDbId: number;
}): Promise<void> => {
  await db.Document.update(
    { status: 'ready' },
    { where: { id: args.documentDbId, status: WITHDRAWN_STATUS } }
  );
};

/** Emitted once a withdrawn document's content is back in the index. */
export const emitDocumentRestored = async (args: {
  id: string;
}): Promise<void> => {
  const doc = await loadDocument(args.id);
  /* istanbul ignore next -- the restore just wrote it. */
  if (!doc) return;

  emitResourceEvent({
    type: 'documents.restored',
    projectId: doc.file?.project?.id as number,
    projectPublicId: doc.file?.project?.publicId,
    resourceType: 'document',
    resourceId: doc.publicId,
    data: mapDocument(doc),
  });
};
