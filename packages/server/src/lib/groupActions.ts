/** The SRN type of a check on the whole group, `srn:group:<group_id>:*`. */
export const WHOLE_GROUP = '*';

/**
 * Every action checked on a group's SRN, with the group resource types it is
 * checked on. Nothing else is checked there, and none of these anywhere else.
 */
export const GROUP_ACTION_RESOURCE_TYPES: Readonly<
  Record<string, readonly string[]>
> = {
  'groups:GetGroup': [WHOLE_GROUP],
  'groups:UpdateGroup': [WHOLE_GROUP],
  'groups:CreateProject': ['project'],
  'groups:ArchiveProject': ['project'],
  'groups:CreateApiKey': ['api_key'],
  'groups:RotateApiKey': ['api_key'],
  'groups:RevokeApiKey': ['api_key'],
  'groups:ListMembers': ['member'],
  'groups:AddMember': ['member'],
  'groups:UpdateMember': ['member'],
  'groups:RemoveMember': ['member'],
  'groups:GetUsage': ['usage'],
  'groups:GetBalance': ['balance'],
  'groups:ListStatements': ['statement'],
};

export const isGroupAction = (action: string): boolean => {
  return Object.hasOwn(GROUP_ACTION_RESOURCE_TYPES, action);
};

const GROUP_SRN_PREFIX = 'srn:group:';

/** `srn:group:<group_id>:<type>/<id>`, or the whole group without a type. */
export const buildGroupSrn = (args: {
  groupPublicId: string;
  resourceType?: string;
  resourceId?: string;
}): string => {
  const root = `${GROUP_SRN_PREFIX}${args.groupPublicId}:`;
  if (args.resourceType === undefined) return `${root}${WHOLE_GROUP}`;
  return `${root}${args.resourceType}/${args.resourceId ?? '*'}`;
};

/** Every SRN of the group: its own resources, whatever their type. */
export const groupSrnPattern = (groupPublicId: string): string => {
  return `${GROUP_SRN_PREFIX}${groupPublicId}:*`;
};

export const isGroupSrn = (resource: string): boolean => {
  return resource.startsWith(GROUP_SRN_PREFIX);
};

const GROUP_SRN =
  /^srn:group:([^:*?/]+):(?:([a-z][a-z0-9_]*)\/([^:*?/]+|\*)|(\*))$/;

/** The group and type a concrete group SRN names, or null when it is none. */
export const parseGroupSrn = (
  resource: string
): { groupPublicId: string; resourceType: string } | null => {
  const match = GROUP_SRN.exec(resource);
  if (!match) return null;
  return { groupPublicId: match[1], resourceType: match[2] ?? match[4] };
};
