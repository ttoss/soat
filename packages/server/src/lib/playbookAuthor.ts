import createDebug from 'debug';

import type { Context } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { resolveJwtAuthUser } from '../middleware/auth';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildSrn } from './iam';
import { buildRunAuthHeader } from './orchestrationRunToken';
import type {
  PlaybookDefinition,
  PlaybookExecutor,
  PlaybookExecutorType,
} from './playbookDefinition';
import type { RequestPrincipal } from './principals';

const log = createDebug('soat:playbooks');

/**
 * What starting each executor takes, as the executor's own start route checks
 * it. A workflow executor creates a task, which no task id names yet.
 */
const EXECUTOR_START: Record<
  PlaybookExecutorType,
  { action: string; resourceType: string; byId: boolean }
> = {
  agent: {
    action: 'agents:CreateAgentGeneration',
    resourceType: 'agent',
    byId: true,
  },
  tool: { action: 'tools:CallTool', resourceType: 'tool', byId: true },
  decider: {
    action: 'deciders:CreateDecision',
    resourceType: 'decider',
    byId: true,
  },
  workflow: { action: 'tasks:CreateTask', resourceType: 'task', byId: false },
  orchestration: {
    action: 'orchestrations:StartRun',
    resourceType: 'orchestration',
    byId: true,
  },
};

export const assertExecutorStartable = async (args: {
  node: string;
  executor: PlaybookExecutor;
  projectPublicId: string;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  const start = EXECUTOR_START[args.executor.type];
  const allowed = await args.isAllowed({
    projectPublicId: args.projectPublicId,
    action: start.action,
    resource: buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: start.resourceType,
      resourceId: start.byId ? args.executor.id : '*',
    }),
  });
  if (!allowed) {
    throw new DomainError(
      'PLAYBOOK_EXECUTOR_FORBIDDEN',
      `The playbook's author may not start the ${args.executor.type} on node '${args.node}'.`,
      { node: args.node, action: start.action }
    );
  }
};

/**
 * Refuses an executor `isAllowed` may not start. Run against the writer when a
 * version is written, and against the version's author before each run, so a
 * permission removed since the write stops the next run.
 */
export const assertExecutorsStartable = async (args: {
  definition: PlaybookDefinition;
  projectPublicId: string;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  for (const node of args.definition.nodes) {
    if (!node.executor) continue;
    await assertExecutorStartable({
      ...args,
      node: node.key,
      executor: node.executor,
    });
  }
};

/**
 * The credential writing a version, which its executors run as. `principal`
 * is null for a credential carrying its boundary in the token (a trigger or
 * OAuth token): no run can be minted from it.
 */
export type PlaybookAuthor = {
  principal: RequestPrincipal | null;
  isAllowed: IsAllowedFn;
};

/** Refuses a definition its writer could not run as the version's author. */
export const assertAuthorCanRun = async (args: {
  definition: PlaybookDefinition;
  projectPublicId: string;
  author: PlaybookAuthor;
}): Promise<void> => {
  const { definition, author } = args;
  const runs = definition.nodes.some((node) => {
    return node.executor !== undefined;
  });
  if (runs && !author.principal) {
    throw new DomainError(
      'PLAYBOOK_AUTHOR_UNAVAILABLE',
      'A definition with executors must be written by a user or an API key: its executors run as the credential that wrote it.'
    );
  }
  await assertExecutorsStartable({
    definition,
    projectPublicId: args.projectPublicId,
    isAllowed: author.isAllowed,
  });
};

/** The version row's author columns. */
export const authorColumns = (principal: RequestPrincipal | null) => {
  return {
    principalKind: principal?.principalType ?? null,
    principalId: principal?.principalId ?? null,
  };
};

/** The author a case's executors run as: who wrote its pinned version. */
export type PlaybookRunAs = {
  principal: RequestPrincipal;
  authHeader: string;
  isAllowed: IsAllowedFn;
};

/**
 * Mints the run-as credential for the author of a case's version and resolves
 * it as a request would be, so the run is authorized by the author's policies
 * as they stand now, with an API key's boundary intact.
 */
export const resolvePlaybookRunAs = async (args: {
  version: { principalKind: string | null; principalId: string | null };
  projectId: number;
  workPublicId: string;
}): Promise<PlaybookRunAs> => {
  const { principalKind, principalId } = args.version;
  const authHeader = await buildRunAuthHeader({
    principalKind,
    principalId,
    projectId: args.projectId,
    workPublicId: args.workPublicId,
  });
  const authUser: Context['authUser'] = authHeader
    ? await resolveJwtAuthUser({
        db,
        token: authHeader.slice('Bearer '.length),
      })
    : undefined;

  if (!authHeader || !authUser || !principalKind || !principalId) {
    log('resolvePlaybookRunAs: no author for %s', args.workPublicId);
    throw new DomainError(
      'PLAYBOOK_AUTHOR_UNAVAILABLE',
      "The case's playbook version has no author its executors can run as."
    );
  }

  return {
    principal: {
      principalType: principalKind === 'api_key' ? 'api_key' : 'user',
      principalId,
    },
    authHeader,
    isAllowed: authUser.isAllowed,
  };
};
