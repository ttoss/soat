import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import { findIamActionRegistration } from './iamRegistrations';
import { buildResourceTagContext, readTagBag } from './tags';

const log = createDebug('soat:iam:check');

/** One project and one registered type; the id may be `*` (a create or list). */
const SRN_PATTERN = /^srn:([^:*?]+):([a-z][a-z0-9_]*):([^:*?]+|\*)$/;

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

/**
 * Whether the caller's own policies allow a deployment-registered action on
 * an SRN, through the same `isAllowed` the runtime's routes call. It evaluates
 * policies only: it neither reads nor asserts that the resource exists.
 */
export const checkIamPermission = async (args: {
  isAllowed: AuthUser['isAllowed'];
  action: unknown;
  resource: unknown;
  tags: unknown;
}): Promise<{ allowed: boolean }> => {
  if (typeof args.action !== 'string') throw invalid('action is required');
  const registration = findIamActionRegistration(args.action);
  if (!registration) {
    throw invalid(
      `action '${args.action}' is not an action this deployment registered`
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
  if (!registration.resourceTypes.has(resourceType)) {
    throw invalid(
      `resource type '${resourceType}' is not one module '${registration.module}' registered`
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
