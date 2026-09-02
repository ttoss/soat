/**
 * The per-resource authorization pre-flight (#1181).
 *
 * A formation was authorized once — `formations:CreateFormation` on the request
 * — and then applied every resource its template declared by calling the
 * module's lib function directly, so the per-action check every REST route
 * performs never ran for anything a template declared. `formations:CreateFormation`
 * was in practice `*` within the project.
 *
 * The check runs here, over the whole template, **before** anything is applied,
 * rather than per resource inside the engine: an apply is ordered and unwinds on
 * failure, so authorizing resource by resource would mean discovering the
 * refusal at resource seven and rolling six back. Asking first refuses the
 * request having changed nothing, and names every action the caller lacks in one
 * answer. It also keeps the engine and the modules free of the principal.
 */
import createDebug from 'debug';
import type { db } from 'src/db';
import { DomainError } from 'src/errors';

import { isCreateChange } from './formationsApplyHelpers';
import { getFormationModule } from './formationsRegistry';
import {
  authorizationDenialToWire,
  type FormationAuthorizationDenial,
  type FormationAuthorizationRequest,
  type FormationAuthorizer,
  type FormationResourceOperation,
  type FormationTemplate,
} from './formationsTypes';

const log = createDebug('soat:formations');

type ResourceRow = InstanceType<(typeof db)['FormationResource']>;

/** A create has no resource yet, so it is authorized against the type's SRN. */
const NEW_RESOURCE_ID = '*';

/**
 * One authorization question, or `null` when the type has no SOAT action to ask
 * about: an operator-registered type (#1078), or a type not in the registry at
 * all — the apply refuses that itself, and inventing a denial for it would
 * report the wrong reason.
 */
const buildAuthorizationRequest = (args: {
  logicalId: string;
  resourceType: string;
  operation: FormationResourceOperation;
  physicalResourceId?: string | null;
}): FormationAuthorizationRequest | null => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule) return null;

  const { authorization } = formationModule;
  if ('operatorRegistered' in authorization) return null;

  const action = authorization[args.operation];
  // A type with no update operation mutates nothing on an update, so there is
  // no permission to demand — see `FormationModuleAuthorization`.
  if (!action) return null;

  return {
    logicalId: args.logicalId,
    resourceType: args.resourceType,
    operation: args.operation,
    action,
    srnResourceType: authorization.srnResourceType,
    resourceId: args.physicalResourceId ?? NEW_RESOURCE_ID,
    adminOnly: authorization.adminOnly === true,
  };
};

/**
 * A ledger row the engine would delete: it has something to delete, has not
 * been deleted already, and is not retained. Mirrors the conditions
 * `handleOrphanedDeletes` and `performResourceDeletions` apply, so the
 * pre-flight never demands a permission for a delete that would not happen.
 */
const isDeletable = (resource: ResourceRow): boolean => {
  return (
    !!resource.physicalResourceId &&
    resource.status !== 'deleted' &&
    resource.deletionPolicy !== 'retain'
  );
};

/**
 * Every action applying `template` over `existingResources` would perform —
 * a create or an update per declared resource, plus a delete per resource the
 * new template no longer declares.
 */
export const collectApplyAuthorizationRequests = (args: {
  template: FormationTemplate;
  existingResources: ResourceRow[];
}): FormationAuthorizationRequest[] => {
  const existingMap = new Map(
    args.existingResources.map((resource) => {
      return [resource.logicalId, resource];
    })
  );

  const requests: FormationAuthorizationRequest[] = [];

  for (const [logicalId, decl] of Object.entries(args.template.resources)) {
    const existing = existingMap.get(logicalId);
    const creating = isCreateChange(existing);
    const request = buildAuthorizationRequest({
      logicalId,
      resourceType: decl.type,
      operation: creating ? 'create' : 'update',
      physicalResourceId: creating ? null : existing?.physicalResourceId,
    });
    if (request) requests.push(request);
  }

  for (const resource of args.existingResources) {
    if (args.template.resources[resource.logicalId]) continue;
    if (!isDeletable(resource)) continue;
    const request = buildAuthorizationRequest({
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      operation: 'delete',
      physicalResourceId: resource.physicalResourceId,
    });
    if (request) requests.push(request);
  }

  return requests;
};

/** Every delete a full teardown would perform. */
export const collectTeardownAuthorizationRequests = (args: {
  existingResources: ResourceRow[];
}): FormationAuthorizationRequest[] => {
  const requests: FormationAuthorizationRequest[] = [];
  for (const resource of args.existingResources) {
    if (!isDeletable(resource)) continue;
    const request = buildAuthorizationRequest({
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      operation: 'delete',
      physicalResourceId: resource.physicalResourceId,
    });
    if (request) requests.push(request);
  }
  return requests;
};

export const collectAuthorizationDenials = async (args: {
  authorize: FormationAuthorizer;
  requests: FormationAuthorizationRequest[];
}): Promise<FormationAuthorizationDenial[]> => {
  const denials: FormationAuthorizationDenial[] = [];
  for (const request of args.requests) {
    if (await args.authorize(request)) continue;
    denials.push({
      logicalId: request.logicalId,
      resourceType: request.resourceType,
      action: request.action,
    });
  }
  return denials;
};

/**
 * Refuses the whole request when the caller lacks any of the actions, naming
 * every one of them.
 *
 * Reporting all of them rather than the first is the point: a template is
 * authored as a unit, so a caller fixing one denial at a time would need one
 * refused request per resource to learn what it needs.
 */
export const assertResourceActionsAuthorized = async (args: {
  authorize: FormationAuthorizer;
  requests: FormationAuthorizationRequest[];
}): Promise<void> => {
  const denials = await collectAuthorizationDenials(args);
  if (denials.length === 0) return;

  const named = denials
    .map((denial) => {
      return `${denial.logicalId} (${denial.action})`;
    })
    .join(', ');

  log(
    'assertResourceActionsAuthorized: denied %d action(s): %s',
    denials.length,
    named
  );

  throw new DomainError(
    'FORBIDDEN',
    `Not permitted to apply ${String(denials.length)} resource(s) this template declares: ${named}. A formation may only do what the caller could do directly.`,
    { denied_actions: denials.map(authorizationDenialToWire) }
  );
};
