/** The SRN type of a check on the whole project group, `srn:project-group:<project_group_id>:*`. */
export const WHOLE_PROJECT_GROUP = '*';

/**
 * Every built-in action checked on a project group's SRN, with the project group resource
 * types it is checked on. Read through `findProjectGroupActionResourceTypes`
 * (`iamRegistrations.ts`), which adds the ones a deployment registers.
 */
export const PROJECT_GROUP_ACTION_RESOURCE_TYPES: Readonly<
  Record<string, readonly string[]>
> = {
  'project-groups:GetProjectGroup': [WHOLE_PROJECT_GROUP],
  'project-groups:UpdateProjectGroup': [WHOLE_PROJECT_GROUP],
  'project-groups:CreateProject': ['project'],
  'project-groups:ArchiveProject': ['project'],
  'project-groups:CreateApiKey': ['api_key'],
  'project-groups:RotateApiKey': ['api_key'],
  'project-groups:RevokeApiKey': ['api_key'],
  'project-groups:ListMembers': ['member'],
  'project-groups:AddMember': ['member'],
  'project-groups:UpdateMember': ['member'],
  'project-groups:RemoveMember': ['member'],
  'project-groups:GetUsage': ['usage'],
  'project-groups:GetBalance': ['balance'],
  'project-groups:ListStatements': ['statement'],
};

const PROJECT_GROUP_SRN_PREFIX = 'srn:project-group:';

/** `srn:project-group:<project_group_id>:<type>/<id>`, or the whole project group without a type. */
export const buildProjectGroupSrn = (args: {
  projectGroupPublicId: string;
  resourceType?: string;
  resourceId?: string;
}): string => {
  const root = `${PROJECT_GROUP_SRN_PREFIX}${args.projectGroupPublicId}:`;
  if (args.resourceType === undefined) return `${root}${WHOLE_PROJECT_GROUP}`;
  return `${root}${args.resourceType}/${args.resourceId ?? '*'}`;
};

/** Every SRN of the project group: its own resources, whatever their type. */
export const projectGroupSrnPattern = (
  projectGroupPublicId: string
): string => {
  return `${PROJECT_GROUP_SRN_PREFIX}${projectGroupPublicId}:*`;
};

export const isProjectGroupSrn = (resource: string): boolean => {
  return resource.startsWith(PROJECT_GROUP_SRN_PREFIX);
};

const PROJECT_GROUP_SRN =
  /^srn:project-group:([^:*?/]+):(?:([a-z][a-z0-9_]*)\/([^:*?/]+|\*)|(\*))$/;

/** The project group and type a concrete group SRN names, or null when it is none. */
export const parseProjectGroupSrn = (
  resource: string
): { projectGroupPublicId: string; resourceType: string } | null => {
  const match = PROJECT_GROUP_SRN.exec(resource);
  if (!match) return null;
  return { projectGroupPublicId: match[1], resourceType: match[2] ?? match[4] };
};
