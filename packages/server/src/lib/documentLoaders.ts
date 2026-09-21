import { db } from '../db';
import type { Transaction } from './dbTransaction';
import { emitResourceEvent } from './eventBus';
import type { SoatEventTypeFor } from './soatEvents';

/**
 * How a document is loaded with the context every mapper and every lifecycle
 * event needs — its backing file and that file's project.
 *
 * Shared rather than repeated because a reader that loaded a document without
 * its project emits an event with no project on it, which the bus drops, and
 * the loss shows up only as a webhook that never fires.
 */

export type LoadedDoc = InstanceType<(typeof db)['Document']> & {
  file?: InstanceType<(typeof db)['File']> & {
    project?: InstanceType<(typeof db)['Project']>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fileAndProjectInclude = (): any[] => {
  return [
    {
      model: db.File,
      as: 'file',
      include: [{ model: db.Project, as: 'project' }],
    },
  ];
};

export const fetchDocumentWithContext = (
  publicId: string
): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { publicId },
    include: fileAndProjectInclude(),
  }) as Promise<LoadedDoc | null>;
};

export const fetchDocumentByIdWithContext = (
  id: number,
  transaction?: Transaction
): Promise<LoadedDoc | null> => {
  return db.Document.findOne({
    where: { id },
    include: fileAndProjectInclude(),
    transaction,
  }) as Promise<LoadedDoc | null>;
};

export const emitDocumentLifecycleEvent = (args: {
  type: SoatEventTypeFor<'document'>;
  doc: LoadedDoc;
  data: Record<string, unknown>;
}) => {
  const project = args.doc.file?.project;
  /* istanbul ignore next -- `file_id` is NOT NULL on a document and
     `project_id` NOT NULL on a file, and every caller loads both through
     `fileAndProjectInclude`, so this narrows the association's optional type
     rather than guarding a state a row can be in. */
  if (!project) return;
  emitResourceEvent({
    type: args.type,
    projectId: project.id,
    projectPublicId: project.publicId,
    resourceType: 'document',
    resourceId: args.doc.publicId,
    data: args.data,
  });
};
