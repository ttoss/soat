import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import { BUILT_IN_ACTION_RESOURCE_TYPES } from './iamActionResourceTypes';
import { findIamActionRegistration } from './iamRegistrations';
import { listAllActions } from './permissionCatalog';
import { buildResourceTagContext, readTagBag } from './tags';

const log = createDebug('soat:iam:check');

/** One project and one type; the id may be `*` (a create or list). */
const SRN_PATTERN = /^srn:([^:*?]+):([a-z][A-Za-z0-9_]*):([^:*?]+|\*)$/;

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
  return {
    owner: `module '${module}' checks its actions on`,
    types: new Set(BUILT_IN_ACTION_RESOURCE_TYPES[module] ?? []),
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

/**
 * Whether the caller's own policies allow a deployment-registered or built-in
 * action on an SRN, through the same `isAllowed` the
 * runtime's routes call. It evaluates policies only: it neither reads nor
 * asserts that the resource exists.
 */
export const checkIamPermission = async (args: {
  isAllowed: AuthUser['isAllowed'];
  action: unknown;
  resource: unknown;
  tags: unknown;
}): Promise<{ allowed: boolean }> => {
  if (typeof args.action !== 'string') throw invalid('action is required');
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
      `resource '${args.resource}' must be srn:<project_id>:<resource_type>:<id|*>`
    );
  }
  const [, projectPublicId, resourceType] = match;
  if (!checkable.types.has(resourceType)) {
    throw invalid(
      `resource type '${resourceType}' is not one ${checkable.owner}`
    );
  }
  const allowed = await args.isAllowed({
    projectPublicId,
    action: args.action,
    resource: args.resource,
    context: buildResourceTagContext({
      resourceType,
      tags: readTagBag(args.tags),
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
