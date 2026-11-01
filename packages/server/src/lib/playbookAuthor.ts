import createDebug from 'debug';

import type { Context } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { resolveJwtAuthUser } from '../middleware/auth';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import {
  buildRunAuthHeader,
  resolveStartingPrincipal,
} from './orchestrationRunToken';
import type {
  PlaybookDefinition,
  PlaybookExecutor,
  PlaybookNode,
} from './playbookDefinition';
import {
  executorResolves,
  toolCallProblem,
  type ToolStart,
} from './playbookExecutorReferences';
import { throwPlaybookDefinitionProblems } from './playbookWire';
import type { StartingPrincipal } from './principals';
import { mayStart, START_ACTIONS } from './startActions';
import type { ValidationProblem } from './validationProblems';

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

/**
 * What a node starts as its author: its executor and each export's tool, with
 * the field of the node that names it.
 */
const startsOf = (
  node: PlaybookNode
): { executor: PlaybookExecutor; field: string; start: ToolStart }[] => {
  return [
    ...(node.executor
      ? [
          {
            executor: node.executor,
            field: 'executor.id',
            start: 'executor' as const,
          },
        ]
      : []),
    ...(node.transformations ?? []).map((transformation, index) => {
      return {
        executor: { type: 'tool' as const, id: transformation.tool },
        field: `transformations[${index}].tool`,
        start: 'transformation' as const,
      };
    }),
  ];
};

export const executorsOf = (node: PlaybookNode): PlaybookExecutor[] => {
  return startsOf(node).map(({ executor }) => {
    return executor;
  });
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
 * Every executor `isAllowed` may start that names nothing a run in the project
 * could start, or a tool or tool action a run could not call. One it may not
 * start is left to the permission check, so the answer never tells a caller
 * whether a resource it cannot start exists.
 */
export const executorReferenceProblems = async (args: {
  definition: PlaybookDefinition;
  projectId: number;
  projectPublicId: string;
  isAllowed: IsAllowedFn;
}): Promise<ValidationProblem[]> => {
  const problems: ValidationProblem[] = [];
  for (const [index, node] of args.definition.nodes.entries()) {
    for (const { executor, field, start } of startsOf(node)) {
      const allowed = await mayStart({
        isAllowed: args.isAllowed,
        projectPublicId: args.projectPublicId,
        type: executor.type,
        id: executor.id,
      });
      if (!allowed) continue;
      if (!(await executorResolves({ executor, projectId: args.projectId }))) {
        problems.push({
          code: 'EXECUTOR_NOT_FOUND',
          path: `definition.nodes[${index}].${field}`,
          message: `Node '${node.id}' starts ${executor.type} '${executor.id}', which does not exist in the project.`,
        });
        continue;
      }
      const callProblem = await toolCallProblem({
        executor,
        start,
        projectId: args.projectId,
      });
      if (callProblem) {
        problems.push({
          code: callProblem.code,
          path: `definition.nodes[${index}].${
            callProblem.on === 'tool' ? field : 'executor.operation_id'
          }`,
          message: `Node '${node.id}': ${callProblem.message}`,
        });
      }
    }
  }
  return problems;
};

/**
 * The credential writing a version, which its executors run as. `principal`
 * is null for a credential carrying its boundary in the token (a trigger or
 * OAuth token): no run can be minted from it.
 */
export type PlaybookAuthor = {
  principal: StartingPrincipal | null;
  isAllowed: IsAllowedFn;
};

/**
 * Refuses a definition its writer could not run as the version's author: one
 * naming an executor it may not start, or one that does not exist.
 */
export const assertAuthorCanRun = async (args: {
  definition: PlaybookDefinition;
  projectId: number;
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
  throwPlaybookDefinitionProblems(
    await executorReferenceProblems({
      definition,
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      isAllowed: author.isAllowed,
    })
  );
};

/** The version row's author columns. */
export const authorColumns = (principal: StartingPrincipal | null) => {
  return {
    principalKind: principal?.principalType ?? null,
    principalId: principal?.principalId ?? null,
  };
};

/** The author a case's executors run as: who wrote its pinned version. */
export type PlaybookRunAs = {
  principal: StartingPrincipal;
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

  const principal = resolveStartingPrincipal({ authHeader });
  if (!authHeader || !authUser || !principal) {
    log('resolvePlaybookRunAs: no author for %s', args.workPublicId);
    throw new DomainError(
      'PLAYBOOK_AUTHOR_UNAVAILABLE',
      "The case's playbook version has no author its executors can run as."
    );
  }

  return {
    principal,
    authHeader,
    isAllowed: authUser.isAllowed,
  };
};
