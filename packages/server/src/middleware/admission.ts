import type { AuthUser, Context } from '../Context';
import {
  assertAdmitted,
  isAdmissionDeclared,
  runInAdmissionScope,
} from '../lib/admission';
import { getOperationIam, matchOpenApiPath } from '../lib/openapiSpec';
import { wrapIsAllowed } from '../lib/permissions';
import { principalFromAuthUser } from '../lib/principals';

type Next = () => Promise<void>;

/** A read never asks, even under an action a write also declares. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Allowed = { action: string; projectPublicId?: string; resource?: string };

type AdmissionGate = (allowed: Allowed) => Promise<void>;

/** `srn:<project>:<type>:<id>` → its id, or `null` for a type-level `*`. */
const resourceIdOf = (resource: string | undefined): string | null => {
  const id = resource?.split(':')[3];
  return id && id !== '*' ? id : null;
};

const gates = new WeakMap<Context, AdmissionGate>();

const buildGate = (args: {
  ctx: Context;
  authUser: AuthUser;
  action: string;
  resourceType: string | null;
}): AdmissionGate => {
  let asked = false;
  return async (allowed) => {
    if (asked || allowed.action !== args.action) return;
    asked = true;
    // A create whose check names no project lands in the credential's own.
    const projectPublicId =
      allowed.projectPublicId ??
      args.authUser.apiKeyProjectPublicId ??
      args.authUser.oauthProjectPublicId ??
      null;
    await assertAdmitted({
      action: args.action,
      projectPublicId,
      resourceType: args.resourceType,
      targetId: resourceIdOf(allowed.resource),
      body: args.ctx.request.body ?? null,
      principal: principalFromAuthUser(args.authUser),
    });
  };
};

/** Asks the gate on every allowed answer of the two functions routes authorize through. */
const instrument = (args: { authUser: AuthUser; gate: AdmissionGate }) => {
  const { authUser, gate } = args;
  const isAllowed = authUser.isAllowed;
  authUser.isAllowed = wrapIsAllowed({
    isAllowed,
    around: async (check) => {
      const allowed = await isAllowed(check);
      if (allowed) {
        await gate({
          action: check.action,
          projectPublicId: check.projectPublicId,
          resource: check.resource ?? check.resources?.[0],
        });
      }
      return allowed;
    },
  });
  const resolveProjectIds = authUser.resolveProjectIds;
  authUser.resolveProjectIds = async (check) => {
    const result = await resolveProjectIds(check);
    if (result !== null) {
      await gate({
        action: check.action,
        projectPublicId: check.projectPublicId,
      });
    }
    return result;
  };
};

/**
 * Asks the deployment's admission service before a declared write executes,
 * once its route's own authorization allowed it. In-process `builtin` calls
 * cross the same stack. A route authorizing without `isAllowed` or
 * `resolveProjectIds` (an admin or ownership gate) asks through
 * {@link admitAuthorized}.
 */
export const admissionMiddleware = async (ctx: Context, next: Next) => {
  const template =
    ctx.authUser && WRITE_METHODS.has(ctx.method)
      ? matchOpenApiPath({ path: ctx.path })
      : null;
  const iam = template
    ? getOperationIam({ method: ctx.method, path: template })
    : null;
  // Every request opens a scope, so a nested call never inherits its caller's asks.
  if (!ctx.authUser || !iam || !isAdmissionDeclared(iam.action)) {
    return runInAdmissionScope(next);
  }
  const gate = buildGate({
    ctx,
    authUser: ctx.authUser,
    action: iam.action,
    resourceType: iam.resourceType,
  });
  gates.set(ctx, gate);
  instrument({ authUser: ctx.authUser, gate });
  return runInAdmissionScope(next);
};

/** For a decision made outside `isAllowed`: asks admission when `action` is the route's. */
export const admitAuthorized = async (
  ctx: Context,
  action: string
): Promise<void> => {
  await gates.get(ctx)?.({ action });
};
