/**
 * The per-resource authorization pre-flight.
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

import { authorizationDenied } from './authorizationDenial';
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
 * about: an operator-registered type, or a type not in the registry at
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
  };
};

/** What applying `decl` also needs on resources its properties name. */
const buildReferenceRequests = (args: {
  request: FormationAuthorizationRequest;
  decl: FormationTemplate['resources'][string];
}): FormationAuthorizationRequest[] => {
  const authorization = getFormationModule({
    resourceType: args.request.resourceType,
  })?.authorization;
  if (!authorization || 'operatorRegistered' in authorization) return [];
  return (authorization.references?.(args.decl.properties) ?? []).map(
    (reference) => {
      return { ...args.request, ...reference };
    }
  );
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
    if (!request) continue;
    requests.push(request, ...buildReferenceRequests({ request, decl }));
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
    const { allowed, resource } = await args.authorize.check(request);
    if (allowed) continue;
    denials.push({
      logicalId: request.logicalId,
      resourceType: request.resourceType,
      action: request.action,
      resource,
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
  const [first, ...rest] = await collectAuthorizationDenials(args);
  if (!first) return;

  log('assertResourceActionsAuthorized: denied %d action(s)', rest.length + 1);

  throw authorizationDenied({
    principal: args.authorize.principal,
    denied: [first, ...rest],
    extra: { denied_actions: [first, ...rest].map(authorizationDenialToWire) },
  });
};
