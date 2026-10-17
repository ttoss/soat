import createDebug from 'debug';

import type { Context } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { resolveJwtAuthUser } from '../middleware/auth';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildRunAuthHeader } from './orchestrationRunToken';
import type {
  PlaybookDefinition,
  PlaybookExecutor,
  PlaybookNode,
} from './playbookDefinition';
import type { RequestPrincipal } from './principals';
import { mayStart, START_ACTIONS } from './startActions';

const log = createDebug('soat:playbooks');

export const assertExecutorStartable = async (args: {
  node: string;
  executor: PlaybookExecutor;
  projectPublicId: string;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  const allowed = await mayStart({
    isAllowed: args.isAllowed,
    projectPublicId: args.projectPublicId,
    type: args.executor.type,
    id: args.executor.id,
  });
  if (!allowed) {
    throw new DomainError(
      'PLAYBOOK_EXECUTOR_FORBIDDEN',
      `The playbook's author may not start the ${args.executor.type} on node '${args.node}'.`,
      { node_id: args.node, action: START_ACTIONS[args.executor.type].action }
    );
  }
};

/** What a node starts as its author: its executor and each export's tool. */
export const executorsOf = (node: PlaybookNode): PlaybookExecutor[] => {
  return [
    ...(node.executor ? [node.executor] : []),
    ...(node.transformations ?? []).map((transformation) => {
      return { type: 'tool' as const, id: transformation.tool };
    }),
  ];
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
    for (const executor of executorsOf(node)) {
      await assertExecutorStartable({ ...args, node: node.id, executor });
    }
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
    return executorsOf(node).length > 0;
  });
  if (runs && !author.principal) {
    throw new DomainError(
      'PLAYBOOK_AUTHOR_UNAVAILABLE',
      'A definition with executors or transformations must be written by a user or an API key: they run as the credential that wrote it.'
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
