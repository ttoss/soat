import { db } from '../db';
import { upsertFileByPath } from './files';

export type Trace = {
  id: string;
  projectId: number;
  agentId: string;
  fileId: string | null;
  stepCount: number;
  createdAt: Date;
};

/**
 * Serializes trace steps so that Error objects (which serialize to `{}` by
 * default) are converted to plain objects with `message`, `name`, and any
 * enumerable properties (e.g. `status`, `body` from HttpToolError).
 */
export const serializeSteps = (steps: unknown[]): unknown[] => {
  return JSON.parse(
    JSON.stringify(steps, (_key, value: unknown) => {
      if (value instanceof Error) {
        return {
          message: value.message,
          name: value.name,
          ...(value as unknown as Record<string, unknown>),
        };
      }
      return value;
    })
  ) as unknown[];
};

const mapTrace = (row: InstanceType<(typeof db)['Trace']>): Trace => {
  return {
    id: row.publicId,
    projectId: row.projectId,
    agentId: row.agentId,
    fileId: row.fileId ?? null,
    stepCount: row.stepCount,
    createdAt: row.createdAt,
  };
};

/**
 * Upserts a Trace row in the DB and writes trace content (steps) to disk
 * via the File system. The file is stored at `/traces/{traceId}.json` under
 * the project's storage directory.
 *
 * Fire-and-forget safe: callers may not await this.
 */
export const saveTrace = async (args: {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  agentDbId?: number | null;
  steps: unknown[];
}): Promise<void> => {
  const serializedSteps = serializeSteps(args.steps);
  const content = Buffer.from(JSON.stringify(serializedSteps), 'utf8');
  const filePath = `/traces/${args.traceId}.json`;

  const fileRecord = await upsertFileByPath({
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    path: filePath,
    fileBuffer: content,
    contentType: 'application/json',
    filename: `${args.traceId}.json`,
  });

  // Find or create the Trace row
  const existing = await db.Trace.findOne({
    where: { publicId: args.traceId },
  });

  if (existing) {
    await existing.update({
      fileDbId: fileRecord.id
        ? ((await db.File.findOne({ where: { publicId: fileRecord.id } }))
            ?.id ?? null)
        : null,
      fileId: fileRecord.id ?? null,
      stepCount: serializedSteps.length,
    });
  } else {
    // Find the file's DB internal id for the FK
    const fileDbRow = fileRecord.id
      ? await db.File.findOne({ where: { publicId: fileRecord.id } })
      : null;

    await db.Trace.create({
      publicId: args.traceId,
      projectId: args.projectId,
      agentId: args.agentId,
      agentDbId: args.agentDbId ?? null,
      fileDbId: fileDbRow?.id ?? null,
      fileId: fileRecord.id ?? null,
      stepCount: serializedSteps.length,
    });
  }
};

export const listTraces = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<{
  data: Trace[];
  total: number;
  limit: number;
  offset: number;
}> => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0)
      return { data: [], total: 0, limit, offset };
    where.projectId = args.projectIds;
  }

  const { count, rows } = await db.Trace.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
  return { data: rows.map(mapTrace), total: count, limit, offset };
};

export const getTrace = async (args: {
  projectIds?: number[];
  traceId: string;
}): Promise<Trace | 'not_found'> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { publicId: args.traceId };
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return 'not_found';
    where.projectId = args.projectIds;
  }

  const row = await db.Trace.findOne({ where });
  if (!row) return 'not_found';

  return mapTrace(row);
};
