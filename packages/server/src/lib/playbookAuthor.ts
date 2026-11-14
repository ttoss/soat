import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { authUserOfWork } from '../middleware/auth';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
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
import {
  intersectBounds,
  parseBound,
  type PrincipalBound,
  serializeBound,
} from './principalBound';
import { principalFromAuthUser, type RequestPrincipal } from './principals';
import { mayStart, START_ACTIONS } from './startActions';
import type { ValidationProblem } from './validationProblems';
import {
  forWork,
  principalAuthority,
  requireWorkAuthority,
  type WorkAuthority,
  workAuthorityMissing,
} from './workAuthority';
import { assertWriterHolds, startOf, type Writer } from './writerRule';

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

/** The principal a version's executors run as, held to the bound it wrote under. */
export type AuthorPrincipal = RequestPrincipal & { bound?: PrincipalBound };

/**
 * The credential writing a version, which its executors run as. `principal`
 * is null for one whose authority a principal and a bound cannot restate (a
 * trigger's grant, an OAuth consent): its executors cannot run.
 */
export type PlaybookAuthor = Writer & { principal: AuthorPrincipal | null };

/** The author a caller writes a version as, or null when it cannot be one. */
export const authorOf = (authUser: AuthUser): AuthorPrincipal | null => {
  const { terms } = authUser;
  if (terms.principal.type === 'trigger') return null;
  const restated = terms.caps.every((cap) => {
    return (
      cap.kind === 'bound' ||
      (cap.kind === 'key' && terms.principal.id === cap.key)
    );
  });
  if (!restated) return null;
  const bounds = terms.caps.flatMap((cap) => {
    return cap.kind === 'bound' ? [cap.bound] : [];
  });
  return {
    ...principalFromAuthUser(authUser),
    ...(bounds.length > 0 ? { bound: intersectBounds({ bounds }) } : {}),
  };
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
  await assertWriterHolds({
    carrier: 'playbookVersions',
    writer: author,
    projectId: args.projectId,
    carried: {
      actions: definition.nodes.flatMap((node) => {
        return executorsOf(node).map(startOf);
      }),
    },
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
export const authorColumns = (principal: AuthorPrincipal | null) => {
  return {
    principalKind: principal?.principalType ?? null,
    principalId: principal?.principalId ?? null,
    principalBound: principal?.bound ? serializeBound(principal.bound) : null,
  };
};

/**
 * The authority a version's executions run under: its author's, pinned to
 * the case's project. Null when the author no longer resolves.
 */
export const versionAuthority = async (args: {
  version: {
    principalKind: string | null;
    principalId: string | null;
    principalBound: object | null;
  } | null;
  projectPublicId: string;
}): Promise<WorkAuthority | null> => {
  const { version } = args;
  const bound = parseBound(version?.principalBound);
  if (!version?.principalId || bound === null) return null;
  const project = args.projectPublicId;
  if (version.principalKind === 'user') {
    return principalAuthority({
      principal: { type: 'user', id: version.principalId },
      bound,
      project,
    });
  }
  if (version.principalKind !== 'api_key') return null;
  const key = await db.ApiKey.findOne({
    where: { publicId: version.principalId },
    include: [{ model: db.User, attributes: ['publicId'] }],
  });
  if (!key?.user) return null;
  return principalAuthority({
    principal: {
      type: 'api_key',
      id: version.principalId,
      owner: key.user.publicId as string,
    },
    bound,
    project,
  });
};

/** The authority a case's executors run under, and its checks. */
export type PlaybookRunAs = {
  authority: WorkAuthority;
  isAllowed: IsAllowedFn;
};

/**
 * Resolves an execution's authority as a request would be, so the run is
 * authorized by its policies as they stand now. Work holding none, or whose
 * authority no longer resolves, is refused.
 */
export const resolvePlaybookRunAs = async (args: {
  authority: WorkAuthority | null;
  workPublicId: string;
}): Promise<PlaybookRunAs> => {
  const authority = requireWorkAuthority({
    authority: args.authority,
    work: args.workPublicId,
  });
  const authUser = await authUserOfWork({ db, authority });
  if (!authUser) {
    log('resolvePlaybookRunAs: unresolved for %s', args.workPublicId);
    throw workAuthorityMissing({ work: args.workPublicId });
  }
  return {
    authority: forWork({ authority, work: args.workPublicId }),
    isAllowed: authUser.isAllowed,
  };
};
