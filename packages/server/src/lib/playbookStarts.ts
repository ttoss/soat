import { DomainError } from '../errors';
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
import { mayStart, START_ACTIONS } from './startActions';
import type { ValidationProblem } from './validationProblems';
import { assertWriterHolds, startOf, type Writer } from './writerRule';

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
      `The version's policy_ids do not allow starting the ${args.executor.type} on node '${args.node}'.`,
      { node_id: args.node, action: START_ACTIONS[args.executor.type].action }
    );
  }
};

/**
 * What a node starts: its executor and each export's tool, with
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

/**
 * Refuses a definition whose writer does not hold what it starts or the
 * `policy_ids` it runs under, or one naming an executor that does not exist.
 */
export const assertWriterCanRun = async (args: {
  definition: PlaybookDefinition;
  policyIds: string[] | null | undefined;
  projectId: number;
  projectPublicId: string;
  writer: Writer;
}): Promise<void> => {
  const { definition, writer } = args;
  await assertWriterHolds({
    carrier: 'playbookVersions',
    writer,
    projectId: args.projectId,
    carried: {
      policyIds: args.policyIds,
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
      isAllowed: writer.isAllowed,
    })
  );
};
