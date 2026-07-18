import { db } from 'src/db';

import { DomainError } from '../errors';

/**
 * Types describing a workflow definition as it is stored (structural keys in
 * camelCase — the case-transform middleware converts the snake_case API
 * contract inbound — while JSON Logic bodies `guard`/`when` and the opaque
 * `payload`/`payloadSchema` bags round-trip verbatim, see caseTransform.ts).
 */
export type WorkflowDispatch = {
  kind: 'agent' | 'orchestration';
  agentId?: string;
  orchestrationId?: string;
  inputMapping?: Record<string, unknown>;
};

export type OnCompleteRule = {
  when: unknown;
  transition: string;
};

export type OnEnter = {
  dispatch: WorkflowDispatch;
  onComplete?: OnCompleteRule[];
  onFailure?: string | null;
};

export type WorkflowState = {
  name: string;
  initial?: boolean;
  terminal?: boolean;
  /** `human` states never dispatch — the task parks until a transition fires. */
  kind?: string;
  /** Reserved for the Phase 3 stall sweeper (seconds). */
  stalledAfter?: number | null;
  onEnter?: OnEnter | null;
};

export type WorkflowTransition = {
  name: string;
  from: string[];
  to: string;
  guard?: unknown;
  requiresApproval?: boolean;
};

const fail = (message: string, meta?: Record<string, unknown>): never => {
  throw new DomainError('WORKFLOW_VALIDATION_FAILED', message, meta);
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0;
};

const validateOnEnterDispatch = (state: WorkflowState): void => {
  const dispatch = state.onEnter?.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    fail(`State '${state.name}' on_enter is missing a dispatch.`, {
      state: state.name,
    });
    return;
  }
  if (dispatch.kind === 'agent') {
    if (!isNonEmptyString(dispatch.agentId)) {
      fail(`State '${state.name}' agent dispatch is missing agent_id.`, {
        state: state.name,
      });
    }
    return;
  }
  if (dispatch.kind === 'orchestration') {
    if (!isNonEmptyString(dispatch.orchestrationId)) {
      fail(
        `State '${state.name}' orchestration dispatch is missing orchestration_id.`,
        { state: state.name }
      );
    }
    return;
  }
  fail(
    `State '${state.name}' dispatch kind must be 'agent' or 'orchestration'.`,
    { state: state.name }
  );
};

const validateStateEntry = (args: {
  state: WorkflowState;
  names: Set<string>;
}): void => {
  const { state, names } = args;
  if (!isNonEmptyString(state.name)) {
    fail('Every state must have a non-empty `name`.');
  }
  if (names.has(state.name)) {
    fail(`Duplicate state name '${state.name}'.`, { name: state.name });
  }
  names.add(state.name);

  if (state.kind === 'human' && state.onEnter) {
    fail(`Human state '${state.name}' cannot declare on_enter automation.`, {
      state: state.name,
    });
  }
  if (state.onEnter) validateOnEnterDispatch(state);
};

const validateStates = (states: WorkflowState[]): void => {
  if (!Array.isArray(states) || states.length === 0) {
    fail('A workflow must define at least one state.');
  }

  const names = new Set<string>();
  for (const state of states) {
    validateStateEntry({ state, names });
  }

  const initialCount = states.filter((s) => {
    return s.initial === true;
  }).length;
  if (initialCount !== 1) {
    fail(
      `A workflow must have exactly one initial state (found ${initialCount}).`
    );
  }
};

const validateStateRouting = (args: {
  state: WorkflowState;
  onEnter: OnEnter;
  transitionNames: Set<string>;
}): void => {
  const { state, onEnter, transitionNames } = args;
  for (const rule of onEnter.onComplete ?? []) {
    if (!isNonEmptyString(rule.transition)) {
      fail(`State '${state.name}' on_complete rule is missing a transition.`, {
        state: state.name,
      });
    }
    if (!transitionNames.has(rule.transition)) {
      fail(
        `State '${state.name}' on_complete references unknown transition '${rule.transition}'.`,
        { state: state.name, transition: rule.transition }
      );
    }
  }
  if (onEnter.onFailure != null && !transitionNames.has(onEnter.onFailure)) {
    fail(
      `State '${state.name}' on_failure references unknown transition '${onEnter.onFailure}'.`,
      { state: state.name, transition: onEnter.onFailure }
    );
  }
};

const validateAutomationRouting = (args: {
  states: WorkflowState[];
  transitionNames: Set<string>;
}): void => {
  for (const state of args.states) {
    if (!state.onEnter) continue;
    validateStateRouting({
      state,
      onEnter: state.onEnter,
      transitionNames: args.transitionNames,
    });
  }
};

const validateTransitionStates = (args: {
  transition: WorkflowTransition;
  stateNames: Set<string>;
}): void => {
  const { transition: t, stateNames } = args;
  if (!Array.isArray(t.from) || t.from.length === 0) {
    fail(`Transition '${t.name}' must list at least one \`from\` state.`, {
      transition: t.name,
    });
  }
  for (const from of t.from) {
    if (!stateNames.has(from)) {
      fail(`Transition '${t.name}' references unknown from-state '${from}'.`, {
        transition: t.name,
        state: from,
      });
    }
  }
  if (!stateNames.has(t.to)) {
    fail(`Transition '${t.name}' references unknown to-state '${t.to}'.`, {
      transition: t.name,
      state: t.to,
    });
  }
};

const validateGuardShape = (t: WorkflowTransition): void => {
  if (t.guard != null && typeof t.guard !== 'object') {
    fail(`Transition '${t.name}' guard must be a JSON Logic object.`, {
      transition: t.name,
    });
  }
};

const validateTransitionEntry = (args: {
  transition: WorkflowTransition;
  stateNames: Set<string>;
  transitionNames: Set<string>;
}): void => {
  const { transition: t, stateNames, transitionNames } = args;
  if (!isNonEmptyString(t.name)) {
    fail('Every transition must have a non-empty `name`.');
  }
  if (transitionNames.has(t.name)) {
    fail(`Duplicate transition name '${t.name}'.`, { name: t.name });
  }
  transitionNames.add(t.name);

  validateTransitionStates({ transition: t, stateNames });
  validateGuardShape(t);
};

const validateTransitions = (args: {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}): void => {
  if (!Array.isArray(args.transitions)) {
    fail('`transitions` must be an array.');
  }

  const stateNames = new Set(
    args.states.map((s) => {
      return s.name;
    })
  );
  const transitionNames = new Set<string>();

  for (const transition of args.transitions) {
    validateTransitionEntry({ transition, stateNames, transitionNames });
  }

  validateAutomationRouting({ states: args.states, transitionNames });
};

/**
 * Statically validates a workflow definition (§5): unique state names, exactly
 * one initial state, transitions referencing existing states, well-formed
 * guards, and on_enter automation whose routing targets exist. Mirrors
 * `assertOrchestrationValid` in shape. Throws `WORKFLOW_VALIDATION_FAILED`.
 */
export const assertWorkflowValid = (args: {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}): void => {
  validateStates(args.states);
  validateTransitions({ states: args.states, transitions: args.transitions });
};

/**
 * Verifies every on_enter dispatch target (agent / orchestration) exists in the
 * owning project. Kept separate from the pure structural checks so the
 * definition can be validated without a project context where needed.
 */
export const assertDispatchTargetsValid = async (args: {
  projectId: number;
  states: WorkflowState[];
}): Promise<void> => {
  for (const state of args.states) {
    const dispatch = state.onEnter?.dispatch;
    if (!dispatch) continue;

    if (dispatch.kind === 'agent' && dispatch.agentId) {
      const agent = await db.Agent.findOne({
        where: { publicId: dispatch.agentId, projectId: args.projectId },
      });
      if (!agent) {
        throw new DomainError(
          'WORKFLOW_VALIDATION_FAILED',
          `State '${state.name}' references agent '${dispatch.agentId}', which does not exist in this project.`,
          { state: state.name, agentId: dispatch.agentId }
        );
      }
    }

    if (dispatch.kind === 'orchestration' && dispatch.orchestrationId) {
      const orch = await db.Orchestration.findOne({
        where: {
          publicId: dispatch.orchestrationId,
          projectId: args.projectId,
        },
      });
      if (!orch) {
        throw new DomainError(
          'WORKFLOW_VALIDATION_FAILED',
          `State '${state.name}' references orchestration '${dispatch.orchestrationId}', which does not exist in this project.`,
          { state: state.name, orchestrationId: dispatch.orchestrationId }
        );
      }
    }
  }
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
