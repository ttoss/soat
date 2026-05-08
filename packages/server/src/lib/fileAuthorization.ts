import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';

type FileAccessRecord = {
  id: string;
  projectId: string;
  path?: string | null;
  tags?: Record<string, unknown> | null;
};

const buildFileTagContext = (args: {
  file: Pick<FileAccessRecord, 'tags'>;
}): Record<string, string> => {
  const context: Record<string, string> = { 'soat:ResourceType': 'file' };

  if (!args.file.tags) {
    return context;
  }

  for (const [key, value] of Object.entries(args.file.tags)) {
    context[`soat:ResourceTag/${key}`] = String(value);
  }

  return context;
};

const buildFileResources = (args: {
  file: Pick<FileAccessRecord, 'id' | 'projectId' | 'path'>;
}): string[] => {
  const resources = [
    buildSrn({
      projectPublicId: args.file.projectId,
      resourceType: 'file',
      resourceId: args.file.id,
    }),
  ];

  if (args.file.path) {
    resources.push(
      buildSrn({
        projectPublicId: args.file.projectId,
        resourceType: 'file',
        resourceId: args.file.path,
      })
    );
  }

  return resources;
};

export const canAccessFile = async (args: {
  authUser: NonNullable<Context['authUser']>;
  action:
    | 'files:GetFile'
    | 'files:DeleteFile'
    | 'files:DownloadFile'
    | 'files:UpdateFileMetadata';
  file: FileAccessRecord;
}): Promise<boolean> => {
  return args.authUser.isAllowed({
    projectPublicId: args.file.projectId,
    action: args.action,
    resources: buildFileResources({ file: args.file }),
    context: buildFileTagContext({ file: args.file }),
  });
};
