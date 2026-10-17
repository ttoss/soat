import { db } from 'src/db';

import { DomainError } from '../errors';
import { agentReferences, toolReferences } from './resourceReferences';
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

/** How each dispatch kind's target is found in the workflow's project. */
const DISPATCH_TARGET_LOOKUPS: Record<
  WorkflowDispatch['kind'],
  {
    noun: string;
    find: (args: { id: string; projectId: number }) => Promise<unknown>;
  }
> = {
  agent: {
    noun: 'agent',
    find: ({ id, projectId }) => {
      return agentReferences.find({ id, projectId, reach: 'project' });
    },
  },
  tool: {
    noun: 'tool',
    find: ({ id, projectId }) => {
      return toolReferences.find({ id, projectId, reach: 'project' });
    },
  },
  orchestration: {
    noun: 'orchestration',
    find: ({ id, projectId }) => {
      return db.Orchestration.findOne({ where: { publicId: id, projectId } });
    },
  },
};

/**
 * Verifies every on_enter dispatch target (agent / tool / orchestration) exists
 * in the owning project. Kept separate from the pure structural checks so the
 * definition can be validated without a project context where needed.
 */
export const assertDispatchTargetsValid = async (args: {
  projectId: number;
  states: WorkflowState[];
}): Promise<void> => {
  const problems: ValidationProblem[] = [];
  for (const [index, state] of args.states.entries()) {
    const dispatch = state.onEnter?.dispatch;
    if (!dispatch) continue;

    const { field, wireName } = DISPATCH_REQUIRED_ID[dispatch.kind];
    const targetId = dispatch[field];
    if (!targetId) continue;

    const lookup = DISPATCH_TARGET_LOOKUPS[dispatch.kind];
    const target = await lookup.find({
      id: targetId,
      projectId: args.projectId,
    });
    if (!target) {
      problems.push({
        code: 'TARGET_NOT_FOUND',
        path: `states[${index}].on_enter.dispatch.${wireName}`,
        message: `State '${state.name}' references ${lookup.noun} '${targetId}', which does not exist in this project.`,
      });
    }
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
