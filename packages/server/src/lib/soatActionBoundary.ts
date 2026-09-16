/**
 * The resource half of a builtin tool's boundary check: what SRN and condition
 * inputs `boundary_policy` is evaluated against for one call.
 *
 * Kept out of `agentToolResolverExternalTools.ts` because it is the only part
 * of that path that reads the database, and because it is the part a reviewer
 * of an authorization change wants to read alone.
 */
import createDebug from 'debug';

import { buildSrn, type PolicyDocument, validatePolicyDocument } from './iam';
import { resolveResourceScope } from './resourceScopes';
import type { SoatResourceRef } from './soatToolsResource';
import { buildResourceTagContext } from './tags';

const log = createDebug('soat:toolBoundary');

export type SoatActionBoundaryScope = {
  resource: string;
  context: Record<string, string>;
};

/**
 * Whether a boundary can tell two resources apart at all. A policy whose every
 * statement is `Resource: ["*"]` (or omits it) with no condition answers the
 * same for every target, so resolving one would be a database read per tool
 * call that cannot change the outcome.
 *
 * Conservative by construction: anything it cannot classify counts as needing
 * the scope, so the cost is a wasted read, never a check made against `*` that
 * should have been made against an SRN.
 */
const boundaryNeedsResourceScope = (boundaryPolicy: unknown): boolean => {
  if (!boundaryPolicy) return false;
  const validation = validatePolicyDocument(boundaryPolicy);
  if (!validation.valid) return false;
  return (boundaryPolicy as PolicyDocument).statement.some((statement) => {
    if (statement.condition) return true;
    const resources = statement.resource ?? ['*'];
    return resources.some((resource) => {
      return resource !== '*';
    });
  });
};

const readResourceId = (args: {
  ref: SoatResourceRef;
  toolArgs: unknown;
}): string | null => {
  if (!args.toolArgs || typeof args.toolArgs !== 'object') return null;
  const value = (args.toolArgs as Record<string, unknown>)[args.ref.from];
  return typeof value === 'string' && value ? value : null;
};

/**
 * `null` leaves the caller with today's resource-less check. That happens when
 * the operation names no resource, when the argument naming it is absent, or
 * when the id resolves to nothing — each of which is fail-closed against a
 * scoped boundary, since `*` matches no statement that names an SRN.
 */
export const resolveSoatActionBoundaryScope = async (args: {
  resourceRef?: SoatResourceRef;
  toolArgs: unknown;
  boundaryPolicy: unknown;
}): Promise<SoatActionBoundaryScope | null> => {
  if (!args.resourceRef) return null;
  if (!boundaryNeedsResourceScope(args.boundaryPolicy)) return null;

  const publicId = readResourceId({
    ref: args.resourceRef,
    toolArgs: args.toolArgs,
  });
  if (!publicId) return null;

  const scope = await resolveResourceScope({
    kind: args.resourceRef.kind,
    publicId,
  });
  if (!scope) {
    log(
      'resolveSoatActionBoundaryScope: %s %s resolved to no scope',
      args.resourceRef.kind,
      publicId
    );
    return null;
  }

  return {
    resource: buildSrn({
      projectPublicId: scope.projectPublicId,
      resourceType: scope.resourceType,
      resourceId: scope.resourceId,
    }),
    context: buildResourceTagContext({
      resourceType: scope.resourceType,
      tags: scope.tags,
    }),
  };
};
