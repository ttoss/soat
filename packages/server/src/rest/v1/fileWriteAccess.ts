import type { Context } from 'src/Context';
import { buildPath } from 'src/lib/filePaths';

import { requireAuth, resolveWriteProjectId } from './helpers';

const readKey = (args: {
  prefix?: string;
  filename?: string;
}): { path: string | null } | { refusal: unknown } => {
  try {
    return { path: buildPath(args) };
  } catch (error) {
    return { refusal: error };
  }
};

/**
 * The project a file write lands in, authorized on the SRN of the path it
 * writes (`srn:{project}:file:{path}`), so a grant on a directory admits the
 * writes under it and no others. A write with no path asks on `file:*`, and so
 * does a key that cannot be read, so a caller without the action learns
 * nothing about it. Every file write route resolves its project here
 * (`tests/harness/fileWriteAccess.test.mjs`).
 */
export const resolveFileWriteProjectId = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: 'files:CreateFile' | 'files:UploadFile';
  prefix?: string;
  filename?: string;
}): Promise<number> => {
  requireAuth(args.ctx);
  const key = readKey({ prefix: args.prefix, filename: args.filename });
  const projectId = await resolveWriteProjectId({
    ctx: args.ctx,
    projectPublicId: args.projectPublicId,
    action: args.action,
    resourceType: 'file',
    resourceId: 'path' in key ? (key.path ?? undefined) : undefined,
  });
  if ('refusal' in key) throw key.refusal;
  return projectId;
};
