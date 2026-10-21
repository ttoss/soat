import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { createDecision } from './decisions';
import { applyInputMapping } from './jsonLogicMapping';
import { startOrchestrationRun } from './orchestrationEngine';
import type { MappedOrchestrationRun } from './orchestrations';
import { isPlainObject } from './plainObject';
import type { PlaybookRunAs } from './playbookAuthor';
import type { JsonValue, PlaybookExecutor } from './playbookDefinition';
import { createTask } from './tasks';
import { NON_SUCCESS_TERMINAL_STATUSES, runDispatch } from './tasksDispatch';

const log = createDebug('soat:playbookExecutions');

/**
 * What starting an executor came to: an output to settle the node with now,
 * or a run that settles it later through its completion event.
 */
export type ExecutorOutcome =
  | { kind: 'settled'; output: JsonValue; runId: string | null }
  | { kind: 'pending'; runId: string };

type StartArgs = {
  executor: PlaybookExecutor;
  /** The node's input values, the context its `input` mapping reads. */
  values: Record<string, JsonValue>;
  /** The executor's input: its mapping over `values`, or `values` itself. */
  input: Record<string, unknown>;
  projectId: number;
  executionPublicId: string;
  title: string;
  runAs: PlaybookRunAs;
};

const failed = (message: string, meta?: Record<string, unknown>) => {
  return new DomainError('PLAYBOOK_EXECUTION_FAILED', message, meta);
};

/** An executor's input: its JSON Logic mapping over the node's values. */
export const executorInput = (args: {
  executor?: PlaybookExecutor;
  values: Record<string, JsonValue>;
}): Record<string, unknown> => {
  const mapping = args.executor?.input;
  return mapping ? applyInputMapping(mapping, args.values) : args.values;
};

/**
 * An agent answers with the object its schema asked for, else its text. A
 * node's output is a value later nodes read by field, not the generation.
 */
const startAgent = async (args: StartArgs): Promise<ExecutorOutcome> => {
  const dispatched = await runDispatch({
    dispatch: { kind: 'agent', agentId: args.executor.id },
    projectId: args.projectId,
    taskPublicId: args.executionPublicId,
    inputs: args.input,
    taskContext: args.values,
    principal: args.runAs.principal,
    // Named while the turn runs, so a write its tools make back through
    // another credential is still traced to this execution.
    onDispatchStarted: async ({ generationId }) => {
      await db.PlaybookExecution.update(
        { runId: generationId },
        { where: { publicId: args.executionPublicId } }
      );
    },
  });
  const result = isPlainObject(dispatched.result) ? dispatched.result : {};
  const output = isPlainObject(result.object) ? result.object : result.content;
  if (typeof output !== 'string' && !isPlainObject(output)) {
    throw failed('The agent answered with neither text nor an object.', {
      generation_id: dispatched.generationId,
    });
  }
  return {
    kind: 'settled',
    output: output as JsonValue,
    runId: dispatched.generationId,
  };
};

/** Through the workflow dispatcher, so the project's tool guardrails decide it. */
const startTool = async (args: StartArgs): Promise<ExecutorOutcome> => {
  const mapping = args.executor.input;
  const dispatched = await runDispatch({
    dispatch: {
      kind: 'tool',
      toolId: args.executor.id,
      inputMapping:
        mapping ??
        Object.fromEntries(
          Object.keys(args.values).map((name) => {
            return [name, { var: name }];
          })
        ),
    },
    projectId: args.projectId,
    taskPublicId: args.executionPublicId,
    inputs: args.input,
    taskContext: args.values,
    principal: args.runAs.principal,
  });
  return {
    kind: 'settled',
    output: dispatched.result as JsonValue,
    runId: null,
  };
};

const startDecider = async (args: StartArgs): Promise<ExecutorOutcome> => {
  const decision = await createDecision({
    projectIds: [args.projectId],
    deciderId: args.executor.id,
    input: args.input,
    wait: true,
    authHeader: args.runAs.authHeader,
  });
  if (decision.status !== 'completed') {
    throw failed('The decision failed.', {
      decision_id: decision.id,
      error: decision.error,
    });
  }
  return {
    kind: 'settled',
    output: decision.answers_by_name as JsonValue,
    runId: decision.id,
  };
};

const startWorkflow = async (args: StartArgs): Promise<ExecutorOutcome> => {
  const task = await createTask({
    projectId: args.projectId,
    workflowId: args.executor.id,
    title: args.title,
    payload: args.input,
    principal: {
      kind: args.runAs.principal.principalType,
      id: args.runAs.principal.principalId,
    },
  });
  // A task created straight into a terminal state is settled by the read that
  // follows a pending outcome.
  return { kind: 'pending', runId: task.id };
};

/** How a run settles a node: its output, or pending while it waits. */
export const orchestrationOutcome = (
  run: Pick<MappedOrchestrationRun, 'id' | 'status' | 'output' | 'error'>
): ExecutorOutcome => {
  if (NON_SUCCESS_TERMINAL_STATUSES.has(run.status)) {
    throw failed(`The orchestration run ended ${run.status}.`, {
      orchestration_run_id: run.id,
      error: run.error,
    });
  }
  if (run.status !== 'completed') return { kind: 'pending', runId: run.id };
  return {
    kind: 'settled',
    output: run.output as JsonValue,
    runId: run.id,
  };
};

const startOrchestration = async (
  args: StartArgs
): Promise<ExecutorOutcome> => {
  return orchestrationOutcome(
    await startOrchestrationRun({
      orchestrationPublicId: args.executor.id,
      projectIds: [args.projectId],
      input: args.input,
      principal: args.runAs.principal,
      wait: true,
    })
  );
};

const STARTERS: Record<
  PlaybookExecutor['type'],
  (args: StartArgs) => Promise<ExecutorOutcome>
> = {
  agent: startAgent,
  tool: startTool,
  decider: startDecider,
  workflow: startWorkflow,
  orchestration: startOrchestration,
};

/**
 * The one entry point every executor is started through. A workflow task left
 * open, or an orchestration run parked on a person or a timer, answers
 * `pending`; its completion event settles the node.
 */
export const startExecutor = async (
  args: StartArgs
): Promise<ExecutorOutcome> => {
  log(
    'startExecutor: %s %s for %s',
    args.executor.type,
    args.executor.id,
    args.executionPublicId
  );
  return STARTERS[args.executor.type](args);
};
