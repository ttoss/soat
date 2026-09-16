/**
 * The authorization preamble every route that acts on one agent shares.
 *
 * Agents used to authorize at project level: the caller's policy was probed
 * with `srn:<project>:agent:*`, which a statement naming one agent can never
 * match, so a policy scoped to one agent reached *nothing* while an action-only
 * one reached every agent in the project. The check now names the agent, the
 * way actors, conversations and memory stores already do — which is also what
 * lets an agent `boundary_policy` be scoped to an agent, since a boundary may
 * only promise the granularity the caller path enforces (#1323).
 *
 * The two refusals the module already answered are kept exactly as they were,
 * because they are a deliberate contract rather than an accident of which
 * helper each route reached for:
 *
 * - a **read** a caller may not perform is `404`, so an agent in a project
 *   they cannot see — or one their policy does not name — does not announce
 *   its existence (`agentVersions.test.ts` pins the tenant boundary);
 * - a **write** is `403`, so a caller who can read an agent is told plainly
 *   that changing it is refused (#1029).
 *
 * An id that names no agent at all is `404` on both, from the same
 * `RESOURCE_NOT_FOUND` the accessor throws.
 */
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { findAgentScope } from 'src/lib/agents';
import { buildSrn } from 'src/lib/iam';

import { assertCredentialProjectScope, requireAuth } from './helpers';

type AgentAccess = { projectIds: number[]; projectPublicId: string };

const authorizeAgent = async (args: {
  ctx: Context;
  action: string;
  /** What a refusal reads as; see the module comment. */
  onDenied: 'hide' | 'refuse';
}): Promise<AgentAccess> => {
  const { ctx } = args;
  requireAuth(ctx);

  const agentId = ctx.params.agent_id;
  const notFound = new DomainError(
    'RESOURCE_NOT_FOUND',
    `Agent '${agentId}' not found.`
  );

  const scope = await findAgentScope({ id: agentId });
  if (!scope) throw notFound;

  // A credential pinned to another project keeps its own refusal, with the
  // remedy in the message; without this it would read as a plain denial.
  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: scope.projectPublicId,
    action: args.action,
  });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: scope.projectPublicId,
    action: args.action,
    resource: buildSrn({
      projectPublicId: scope.projectPublicId,
      resourceType: 'agent',
      resourceId: agentId,
    }),
  });
  if (!allowed) {
    throw args.onDenied === 'hide'
      ? notFound
      : new DomainError('FORBIDDEN', 'Forbidden');
  }

  // The lib calls keep taking a project scope: authorization is settled here,
  // and narrowing to the agent's own project keeps a lookup from reaching past
  // it.
  return {
    projectIds: [scope.projectId],
    projectPublicId: scope.projectPublicId,
  };
};

/** `Get` / `List` on one agent: a refusal is indistinguishable from absence. */
export const authorizeAgentRead = async (args: {
  ctx: Context;
  action: string;
}): Promise<AgentAccess> => {
  return authorizeAgent({ ...args, onDenied: 'hide' });
};

/** Anything that changes an agent or runs it: a refusal says so. */
export const authorizeAgentWrite = async (args: {
  ctx: Context;
  action: string;
}): Promise<AgentAccess> => {
  return authorizeAgent({ ...args, onDenied: 'refuse' });
};
