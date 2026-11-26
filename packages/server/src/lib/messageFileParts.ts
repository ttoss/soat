import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import { fileAccessCheck } from './fileAuthorization';
import { assertNotSingleUse } from './fileLifetime';
import { fileReferenceUrl } from './modelInputBoundary';
import { assertAllowedUnder, callerNamedAuthority } from './turnAuthority';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:message-file-parts');

export type FileMessageContentPart = { type: 'file'; file_id: string };

export const isFileMessageContentPart = (
  value: unknown
): value is FileMessageContentPart => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    Reflect.get(value, 'type') === 'file' &&
    typeof Reflect.get(value, 'file_id') === 'string'
  );
};

type FilePartArgs = {
  part: FileMessageContentPart;
  turnProjectId: number;
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  agentAuthority?: AgentAuthority;
};

/** The file a part names, in the turn's project, read as the caller. */
const readableFile = async (args: FilePartArgs) => {
  log(
    'readableFile: fileId=%s projectId=%d',
    args.part.file_id,
    args.turnProjectId
  );
  const file = await db.File.findOne({
    where: { publicId: args.part.file_id, projectId: args.turnProjectId },
    include: [{ model: db.Project, as: 'project', attributes: ['publicId'] }],
  });
  if (!file?.project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `File '${args.part.file_id}' not found.`
    );
  }

  await assertAllowedUnder({
    authority: callerNamedAuthority(args),
    caller: args.authUser,
    checks: [
      fileAccessCheck({
        action: 'files:DownloadFile',
        file: {
          id: file.publicId,
          projectId: file.project.publicId,
          path: file.path,
          tags: file.tags,
        },
      }),
    ],
  });

  return file;
};

/**
 * A stored file as a message part the model reads natively, in its own media
 * type. The caller names it, so it is read as the caller
 * (`callerNamedAuthority`), held to the turn's project. The part carries a
 * reference, never the bytes (`modelInputBoundary.ts`).
 */
export const resolveFileContentPart = async (
  args: FilePartArgs
): Promise<{
  type: 'file';
  data: string;
  mediaType: string;
  filename?: string;
}> => {
  const file = await readableFile(args);
  return {
    type: 'file',
    data: fileReferenceUrl(file.publicId),
    mediaType: file.contentType ?? 'application/octet-stream',
    ...(file.filename ? { filename: file.filename } : {}),
  };
};

/**
 * Refuses, when a turn is written, a file it could not send: one outside the
 * conversation's project or one the writer may not download. The turn is read
 * again, as the caller of the generation that sends it, when it is sent.
 */
export const assertMessageFilesReadable = async (args: {
  fileIds: readonly string[];
  role: string;
  turnProjectId: number;
  authority: WorkAuthority | null;
  authUser?: AuthUser;
}): Promise<void> => {
  if (args.fileIds.length === 0) return;
  if (args.role !== 'user') {
    throw new DomainError(
      'VALIDATION_FAILED',
      '`file_ids` is accepted only on a `user` message.'
    );
  }
  for (const fileId of args.fileIds) {
    assertNotSingleUse(
      await readableFile({ ...args, part: { type: 'file', file_id: fileId } })
    );
  }
};
