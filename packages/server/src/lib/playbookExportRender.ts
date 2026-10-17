import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { systemPath } from './filePaths';
import { upsertFileByPath } from './files';
import { isPlainObject } from './plainObject';
import { PLAYBOOK_EXPORT_FORMATS } from './playbookDefinition';
import type { RequestPrincipal } from './principals';
import {
  INTERNAL_FAILURE,
  type StoredError,
  toStoredError,
} from './storedError';
import { runDispatch } from './tasksDispatch';

const log = createDebug('soat:playbookExports');

type ExportRow = InstanceType<(typeof db)['PlaybookExport']>;

/** The case an export renders, as the render needs it. */
export type ExportCase = {
  publicId: string;
  subject: string;
  projectId: number;
  projectPublicId: string;
};

type ToolFile = { contentType: string; filename?: string; dataBase64: string };

/** A tool's file: the shape an http tool answers with `response_mode: base64`. */
const readToolFile = (result: unknown): ToolFile => {
  if (
    isPlainObject(result) &&
    typeof result.content_type === 'string' &&
    typeof result.data_base64 === 'string'
  ) {
    return {
      contentType: result.content_type.split(';')[0].trim().toLowerCase(),
      ...(typeof result.filename === 'string' && { filename: result.filename }),
      dataBase64: result.data_base64,
    };
  }
  throw new DomainError(
    'PLAYBOOK_EXPORT_FAILED',
    'The transformation tool answered no file: it must answer with `execute.response_mode: base64`.'
  );
};

/** Calls the transformation's tool on the revision's value and files what it answers. */
const renderFile = async (args: {
  exported: ExportRow;
  exportCase: ExportCase;
  principal: RequestPrincipal;
}): Promise<number> => {
  const { exported, exportCase } = args;
  const entry = await db.PlaybookEntry.findOne({
    where: { caseId: exported.caseId, revision: exported.revision },
  });
  const context: Record<string, unknown> = {
    case_id: exportCase.publicId,
    subject: exportCase.subject,
    node: exported.node,
    revision: exported.revision,
    output: entry!.value,
  };
  const dispatched = await runDispatch({
    dispatch: {
      kind: 'tool',
      toolId: exported.toolId,
      inputMapping: Object.fromEntries(
        Object.keys(context).map((key) => {
          return [key, { var: key }];
        })
      ),
    },
    projectId: exportCase.projectId,
    taskPublicId: exported.publicId,
    inputs: context,
    taskContext: context,
    principal: args.principal,
  });

  const file = readToolFile(dispatched.result);
  const expected =
    PLAYBOOK_EXPORT_FORMATS[
      exported.format as keyof typeof PLAYBOOK_EXPORT_FORMATS
    ];
  if (file.contentType !== expected) {
    throw new DomainError(
      'PLAYBOOK_EXPORT_FORMAT_MISMATCH',
      `The transformation tool answered ${file.contentType}, not ${exported.format}.`,
      { format: exported.format, content_type: file.contentType }
    );
  }

  const stored = await upsertFileByPath({
    projectId: exportCase.projectId,
    projectPublicId: exportCase.projectPublicId,
    path: systemPath({
      module: 'playbooks',
      leaf: `${exportCase.publicId}/${exported.node}/${exported.revision}/${exported.publicId}.${exported.format}`,
    }),
    fileBuffer: Buffer.from(file.dataBase64, 'base64'),
    contentType: file.contentType,
    filename: file.filename ?? `${exported.transformation}.${exported.format}`,
  });
  const row = await db.File.findOne({
    where: { publicId: stored.id },
    attributes: ['id'],
  });
  return row!.id as number;
};

/**
 * Renders an export this process recorded as `running` and settles it. Never
 * throws: whatever stops the render is the export's `error`.
 */
export const renderPlaybookExport = async (args: {
  exportId: number;
  exportCase: ExportCase;
  principal: RequestPrincipal;
}): Promise<void> => {
  const exported = (await db.PlaybookExport.findByPk(args.exportId))!;
  log('renderPlaybookExport: %s', exported.publicId);
  let settlement: { fileId: number } | { error: StoredError };
  try {
    settlement = { fileId: await renderFile({ ...args, exported }) };
  } catch (error) {
    log('renderPlaybookExport: %s failed %o', exported.publicId, error);
    settlement = {
      error: toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: 'playbook export',
      }),
    };
  }
  await db.PlaybookExport.update(
    {
      ...settlement,
      status: 'fileId' in settlement ? 'completed' : 'failed',
      leaseExpiresAt: null,
      finishedAt: new Date(),
    },
    { where: { id: exported.id as number, status: 'running' } }
  );
};

/**
 * Fails, as interrupted, every export whose process stopped before it
 * settled. Never rendered again on its own: its tool may have done more than
 * answer a file.
 */
export const recoverPlaybookExports = async (
  args: { now?: Date } = {}
): Promise<number> => {
  const now = args.now ?? new Date();
  const [count] = await db.PlaybookExport.update(
    {
      status: 'failed',
      error: {
        code: 'PLAYBOOK_EXPORT_INTERRUPTED',
        message: 'The process rendering this export stopped before it settled.',
      },
      leaseExpiresAt: null,
      finishedAt: now,
    },
    { where: { status: 'running', leaseExpiresAt: { [Op.lt]: now } } }
  );
  log('recoverPlaybookExports: %d interrupted', count);
  return count;
};
