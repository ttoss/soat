import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import { buildResourceTagContext } from 'src/lib/tags';

type FileAccessRecord = {
  id: string;
  projectId: string;
  path?: string | null;
  tags?: Record<string, string> | null;
};

const buildFileTagContext = (args: {
  file: Pick<FileAccessRecord, 'tags'>;
}): Record<string, string> => {
  return buildResourceTagContext({
    resourceType: 'file',
    tags: args.file.tags,
  });
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

type FileAction =
  | 'files:GetFile'
  | 'files:DeleteFile'
  | 'files:DownloadFile'
  | 'files:UpdateFileMetadata';

/** The one check every read of a file asks: its id and path SRNs, its tags. */
export const fileAccessCheck = (args: {
  action: FileAction;
  file: FileAccessRecord;
}) => {
  return {
    projectPublicId: args.file.projectId,
    action: args.action,
    resources: buildFileResources({ file: args.file }),
    context: buildFileTagContext({ file: args.file }),
  };
};

export const canAccessFile = async (args: {
  authUser: NonNullable<Context['authUser']>;
  action: FileAction;
  file: FileAccessRecord;
}): Promise<boolean> => {
  return args.authUser.isAllowed(fileAccessCheck(args));
};
