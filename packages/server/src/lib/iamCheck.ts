import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import {
  BUILT_IN_ACTION_RESOURCE_TYPES,
  UNTYPED_BUILT_IN_MODULES,
  WHOLE_PROJECT,
} from './iamActionResourceTypes';
import {
  findIamActionRegistration,
  findProjectGroupActionResourceTypes,
} from './iamRegistrations';
import { listAllActions } from './permissionCatalog';
import { isProjectGroupSrn, parseProjectGroupSrn } from './projectGroupActions';
import { buildResourceTagContext, readTagBag } from './tags';

const log = createDebug('soat:iam:check');

/**
 * One project and one type, the id `*` for a create or list; or the whole
 * project, `srn:<project_id>:*:*`.
 */
const SRN_PATTERN =
  /^srn:([^:*?]+):(?:([a-z][A-Za-z0-9_]*):([^:*?]+|\*)|(\*):\*)$/;

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

/** The resource types `action` is checked on, or `null` when it is not one. */
const checkableResourceTypes = (
  action: string
): { owner: string; types: ReadonlySet<string> } | null => {
  const registration = findIamActionRegistration(action);
  if (registration) {
    return {
      owner: `module '${registration.module}' registered`,
      types: registration.resourceTypes,
    };
  }
  if (!listAllActions().has(action)) return null;
  const module = action.split(':')[0];
  const untyped = Object.hasOwn(UNTYPED_BUILT_IN_MODULES, module)
    ? UNTYPED_BUILT_IN_MODULES[module].checkedOn
    : null;
  return {
    owner: `module '${module}' checks its actions on`,
    types: new Set(
      BUILT_IN_ACTION_RESOURCE_TYPES[module] ?? (untyped ? [untyped] : [])
    ),
  };
};

/** Whether `iam/check` answers `action` on `resourceType`. */
export const isCheckableOn = (args: {
  action: string;
  resourceType: string;
}): boolean => {
  return (
    checkableResourceTypes(args.action)?.types.has(args.resourceType) ?? false
  );
};

/**
 * Throws naming the first declared action `iam/check` would not answer on its
 * type: a declaration nothing can be granted would refuse every write.
 */
export const assertDeclaredActionsCheckable = (args: {
  owner: string;
  actions: ReadonlyArray<{ action: string; resourceType: string }>;
}): void => {
  for (const { action, resourceType } of args.actions) {
    if (isCheckableOn({ action, resourceType })) continue;
    throw new Error(
      `${args.owner} declares ${action} on '${resourceType}', which is neither a built-in action on that type nor one a registered IAM module declares on it`
    );
  }
};

/** A project group action on its project group's SRN, through `isAllowedOnProjectGroup`. */
const checkProjectGroupPermission = async (args: {
  isAllowedOnProjectGroup: AuthUser['isAllowedOnProjectGroup'];
  action: string;
  types: ReadonlySet<string>;
  resource: string;
  tags: unknown;
}): Promise<{ allowed: boolean }> => {
  const parsed = parseProjectGroupSrn(args.resource);
  if (!parsed) {
    throw invalid(
      `resource '${args.resource}' must be srn:project-group:<project_group_id>:<resource_type>/<id|*> or srn:project-group:<project_group_id>:*`
    );
  }
  if (!args.types.has(parsed.resourceType)) {
    throw invalid(
      `resource type '${parsed.resourceType}' is not one project group action '${args.action}' is checked on`
    );
  }
  if (args.tags !== undefined)
    throw invalid('a project group resource carries no tags');
  const allowed = await args.isAllowedOnProjectGroup({
    projectGroupPublicId: parsed.projectGroupPublicId,
    action: args.action,
    resource: args.resource,
  });
  log(
    'checkProjectGroupPermission: action=%s resource=%s allowed=%s',
    args.action,
    args.resource,
    allowed
  );
  return { allowed };
};

/**
 * The project group types a check on a project group is answered on, or `null` for a
 * check on a project; a project group action is checked nowhere else.
 */
const projectGroupTypesOf = (args: {
  action: string;
  resource: unknown;
}): ReadonlySet<string> | null => {
  const onProjectGroup =
    typeof args.resource === 'string' && isProjectGroupSrn(args.resource);
  const types = findProjectGroupActionResourceTypes(args.action);
  if (onProjectGroup !== (types !== undefined)) {
    throw invalid(
      `action '${args.action}' and resource must both be a project group's, srn:project-group:<project_group_id>:..., or neither`
    );
  }
  return types ?? null;
};

/** A project action on an SRN of one project, through `isAllowed`. */
const checkProjectPermission = async (args: {
  isAllowed: AuthUser['isAllowed'];
  action: string;
  resource: unknown;
  tags: unknown;
}): Promise<{ allowed: boolean }> => {
  const checkable = checkableResourceTypes(args.action);
  if (!checkable) {
    throw invalid(
      `action '${args.action}' is neither an action this deployment registered nor a built-in one`
    );
  }
  if (typeof args.resource !== 'string') throw invalid('resource is required');
  const match = SRN_PATTERN.exec(args.resource);
  if (!match) {
    throw invalid(
      `resource '${args.resource}' must be srn:<project_id>:<resource_type>:<id|*> or srn:<project_id>:*:*`
    );
  }
  const projectPublicId = match[1];
  const resourceType = match[2] ?? match[4];
  if (!checkable.types.has(resourceType)) {
    throw invalid(
      `resource type '${resourceType}' is not one ${checkable.owner}`
    );
  }
  // The project's own routes evaluate with no context: no resource carries tags.
  if (resourceType === WHOLE_PROJECT && args.tags !== undefined) {
    throw invalid('the whole project carries no tags');
  }
  const allowed = await args.isAllowed({
    projectPublicId,
    action: args.action,
    resource: args.resource,
    ...(resourceType === WHOLE_PROJECT
      ? {}
      : {
          context: buildResourceTagContext({
            resourceType,
            tags: readTagBag(args.tags),
          }),
        }),
  });
  log(
    'checkIamPermission: action=%s resource=%s allowed=%s',
    args.action,
    args.resource,
    allowed
  );
  return { allowed };
};

/**
 * Whether the caller's own policies allow a deployment-registered or built-in
 * action on an SRN, through the same `isAllowed` the
 * runtime's routes call. It evaluates policies only: it neither reads nor
 * asserts that the resource exists.
 */
export const checkIamPermission = async (args: {
  isAllowed: AuthUser['isAllowed'];
  isAllowedOnProjectGroup: AuthUser['isAllowedOnProjectGroup'];
  action: unknown;
  resource: unknown;
  tags: unknown;
}): Promise<{ allowed: boolean }> => {
  if (typeof args.action !== 'string') throw invalid('action is required');
  const types = projectGroupTypesOf({
    action: args.action,
    resource: args.resource,
  });
  if (types && typeof args.resource === 'string') {
    return checkProjectGroupPermission({
      ...args,
      action: args.action,
      types,
      resource: args.resource,
    });
  }
  return checkProjectPermission({ ...args, action: args.action });
};
