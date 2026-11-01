import { db } from 'src/db';

import { DomainError } from '../errors';
import { agentReferences, toolReferences } from './resourceReferences';
import { serverSideToolValidationProblem } from './serverSideToolValidation';
import type { ValidationProblem } from './validationProblems';
import { DISPATCH_REQUIRED_ID, refuseWorkflow } from './workflowsStructure';
import type {
  WorkflowDispatch,
  WorkflowState,
  WorkflowTransition,
} from './workflowsTypes';

export {
  assertWorkflowValid,
  initialStateOf,
  refuseWorkflow,
} from './workflowsStructure';
export type {
  OnCompleteRule,
  OnEnter,
  RetryPolicy,
  WorkflowDispatch,
  WorkflowState,
  WorkflowTransition,
} from './workflowsTypes';
export {
  workflowCollectionToCamel,
  workflowCollectionToSnake,
} from './workflowsWire';

type DispatchTarget = {
  id: string;
  projectId: number;
  dispatch: WorkflowDispatch;
  /** The dispatch's wire path, `states[i].on_enter.dispatch`. */
  path: string;
  stateName: string;
};

const targetNotFound = (
  args: DispatchTarget & { noun: string }
): ValidationProblem => {
  const { wireName } = DISPATCH_REQUIRED_ID[args.dispatch.kind];
  return {
    code: 'TARGET_NOT_FOUND',
    path: `${args.path}.${wireName}`,
    message: `State '${args.stateName}' references ${args.noun} '${args.id}', which does not exist in this project.`,
  };
};

/** Why each dispatch kind's target cannot be dispatched, or null. */
const DISPATCH_TARGET_PROBLEMS: Record<
  WorkflowDispatch['kind'],
  (args: DispatchTarget) => Promise<ValidationProblem | null>
> = {
  agent: async (args) => {
    const agent = await agentReferences.find({
      id: args.id,
      projectId: args.projectId,
      reach: 'project',
    });
    return agent ? null : targetNotFound({ ...args, noun: 'agent' });
  },
  tool: async (args) => {
    const tool = await toolReferences.find({
      id: args.id,
      projectId: args.projectId,
      reach: 'project',
    });
    if (!tool) return targetNotFound({ ...args, noun: 'tool' });
    return serverSideToolValidationProblem({
      tool,
      action: args.dispatch.operationId,
      toolPath: `${args.path}.tool_id`,
      actionPath: `${args.path}.operation_id`,
    });
  },
  orchestration: async (args) => {
    const orchestration = await db.Orchestration.findOne({
      where: { publicId: args.id, projectId: args.projectId },
    });
    return orchestration
      ? null
      : targetNotFound({ ...args, noun: 'orchestration' });
  },
};

/**
 * Verifies every on_enter dispatch target (agent / tool / orchestration) exists
 * in the owning project, and that a tool target runs server-side. Kept separate
 * from the pure structural checks so the definition can be validated without a
 * project context where needed.
 */
export const assertDispatchTargetsValid = async (args: {
  projectId: number;
  states: WorkflowState[];
}): Promise<void> => {
  const problems: ValidationProblem[] = [];
  for (const [index, state] of args.states.entries()) {
    const dispatch = state.onEnter?.dispatch;
    if (!dispatch) continue;

    const targetId = dispatch[DISPATCH_REQUIRED_ID[dispatch.kind].field];
    if (!targetId) continue;

    const problem = await DISPATCH_TARGET_PROBLEMS[dispatch.kind]({
      id: targetId,
      projectId: args.projectId,
      dispatch,
      path: `states[${index}].on_enter.dispatch`,
      stateName: state.name,
    });
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) refuseWorkflow(problems);
};

type JsonSchemaLike = {
  required?: string[];
  properties?: Record<string, { type?: string }>;
};

const isPrimitiveTypeMatch = (expected: string, value: unknown): boolean => {
  if (expected === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  const actual = Array.isArray(value) ? 'array' : typeof value;
  return actual === expected;
};

/**
 * Lightweight payload validation against a workflow's `payload_schema`: checks
 * `required` keys are present and primitive-typed properties match their
 * declared JSON-schema `type`. Same no-ajv approach as
 * `validateOrchestrationInput`. Throws `TASK_PAYLOAD_INVALID` on violation.
 */
export const validatePayload = (args: {
  payloadSchema: unknown;
  payload: Record<string, unknown>;
}): void => {
  const schema = args.payloadSchema as JsonSchemaLike | null | undefined;
  if (!schema || typeof schema !== 'object') return;

  const missing = (schema.required ?? []).filter((key) => {
    return args.payload[key] === undefined;
  });
  if (missing.length > 0) {
    throw new DomainError(
      'TASK_PAYLOAD_INVALID',
      `Missing required payload field(s): ${missing.join(', ')}.`,
      { missing }
    );
  }

  const mismatches = Object.entries(schema.properties ?? {})
    .filter(([key, spec]) => {
      const value = args.payload[key];
      return (
        value !== undefined &&
        spec.type !== undefined &&
        !isPrimitiveTypeMatch(spec.type, value)
      );
    })
    .map(([key, spec]) => {
      return `${key} (expected ${spec.type})`;
    });
  if (mismatches.length > 0) {
    throw new DomainError(
      'TASK_PAYLOAD_INVALID',
      `Payload type mismatch: ${mismatches.join('; ')}.`,
      { mismatches }
    );
  }
};

/** Returns the transition named `name` that is valid from `fromState`, or null. */
export const findValidTransition = (args: {
  transitions: WorkflowTransition[];
  name: string;
  fromState: string;
}): WorkflowTransition | null => {
  const transition = args.transitions.find((t) => {
    return t.name === args.name;
  });
  if (!transition) return null;
  if (!transition.from.includes(args.fromState)) return null;
  return transition;
};
