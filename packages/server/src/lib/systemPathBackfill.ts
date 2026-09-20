import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { systemPath } from './filePaths';

const log = createDebug('soat:systemPath');

/**
 * Moves what the runtime wrote before `/.system/` existed into it: conversation
 * message documents, which carried no path at all, and trace objects, which sat
 * at `/traces/`.
 *
 * Only the `path` moves. The bytes stay where they are — `storagePath` is
 * recorded per row and read back from it, and the storage category only decides
 * where a *new* object lands.
 *
 * Idempotent: each pass selects rows still at the old location, so a second run
 * finds none. A caller file already occupying a target key is reported rather
 * than overwritten — the collision is a caller's row, and losing it to a
 * backfill would be worse than leaving one trace unmoved.
 */
export type SystemPathBackfillResult = {
  messages: number;
  traces: number;
  conflicts: string[];
};

const LEGACY_TRACE_PREFIX = '/traces/';

const moveFile = async (args: {
  fileId: number;
  projectId: number;
  path: string;
  conflicts: string[];
}): Promise<boolean> => {
  const taken = await db.File.findOne({
    where: { projectId: args.projectId, path: args.path },
  });
  if (taken && taken.id !== args.fileId) {
    args.conflicts.push(args.path);
    return false;
  }
  await db.File.update({ path: args.path }, { where: { id: args.fileId } });
  return true;
};

const backfillMessages = async (conflicts: string[]): Promise<number> => {
  const messages = await db.ConversationMessage.findAll({
    include: [
      { model: db.Conversation, as: 'conversation' },
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
    ],
  });

  let moved = 0;
  for (const message of messages) {
    const file = message.document?.file;
    const conversation = message.conversation;
    if (!file || !conversation || file.path !== null) continue;

    const didMove = await moveFile({
      fileId: file.id as number,
      projectId: file.projectId,
      path: systemPath({
        module: 'conversations',
        leaf: `${conversation.publicId}/${message.document!.publicId}.txt`,
      }),
      conflicts,
    });
    if (didMove) moved += 1;
  }
  return moved;
};

const backfillTraces = async (conflicts: string[]): Promise<number> => {
  const traces = await db.Trace.findAll({
    include: [{ model: db.File, as: 'file' }],
  });

  let moved = 0;
  for (const trace of traces) {
    const file = trace.file;
    if (!file?.path?.startsWith(LEGACY_TRACE_PREFIX)) continue;

    const didMove = await moveFile({
      fileId: file.id as number,
      projectId: file.projectId,
      path: systemPath({
        module: 'traces',
        leaf: file.path.slice(LEGACY_TRACE_PREFIX.length),
      }),
      conflicts,
    });
    if (didMove) moved += 1;
  }
  return moved;
};

export const backfillSystemPaths =
  async (): Promise<SystemPathBackfillResult> => {
    const conflicts: string[] = [];
    const messages = await backfillMessages(conflicts);
    const traces = await backfillTraces(conflicts);

    log(
      'backfillSystemPaths: messages=%d traces=%d conflicts=%d',
      messages,
      traces,
      conflicts.length
    );
    return { messages, traces, conflicts };
  };

/** Rows still at an old location, for a dry run. */
export const countUnmigratedSystemPaths = async (): Promise<{
  messages: number;
  traces: number;
}> => {
  const [messages, traces] = await Promise.all([
    db.ConversationMessage.count({
      include: [
        {
          model: db.Document,
          as: 'document',
          required: true,
          include: [
            {
              model: db.File,
              as: 'file',
              required: true,
              where: { path: null },
            },
          ],
        },
      ],
    }),
    db.Trace.count({
      include: [
        {
          model: db.File,
          as: 'file',
          required: true,
          where: { path: { [Op.like]: `${LEGACY_TRACE_PREFIX}%` } },
        },
      ],
    }),
  ]);
  return { messages, traces };
};
