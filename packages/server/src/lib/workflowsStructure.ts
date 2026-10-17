import createDebug from 'debug';

import { isPlainObject } from './plainObject';
import {
  throwValidationProblems,
  type ValidationProblem,
} from './validationProblems';
import { retryPolicyProblems } from './workflowsRetryPolicy';
import type {
  WorkflowDispatch,
  WorkflowState,
  WorkflowTransition,
} from './workflowsTypes';

const log = createDebug('soat:workflows');

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0;
};

/**
 * The id field each dispatch kind requires, and the wire name to report when it
 * is missing. A table rather than a chain of branches, so adding a kind is a row
 * — and so the "unknown kind" message below can never drift out of step with the
 * kinds actually accepted.
 */
export const DISPATCH_REQUIRED_ID: Record<
  WorkflowDispatch['kind'],
  { field: 'agentId' | 'orchestrationId' | 'toolId'; wireName: string }
> = {
  agent: { field: 'agentId', wireName: 'agent_id' },
  orchestration: { field: 'orchestrationId', wireName: 'orchestration_id' },
  tool: { field: 'toolId', wireName: 'tool_id' },
};

const KNOWN_DISPATCH_KINDS = Object.keys(DISPATCH_REQUIRED_ID) as Array<
  WorkflowDispatch['kind']
>;

/** Refuses a workflow definition with every problem found. */
export const refuseWorkflow = (problems: ValidationProblem[]): never => {
  return throwValidationProblems({
    code: 'WORKFLOW_VALIDATION_FAILED',
    subject: 'Workflow',
    problems,
    warnings: null,
  });
};

const onEnterDispatchProblems = (args: {
  state: WorkflowState;
  path: string;
}): ValidationProblem[] => {
  const { state, path } = args;
  const dispatch = state.onEnter?.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    return [
      {
        code: 'MISSING_FIELD',
        path: `${path}.dispatch`,
        message: `State '${state.name}' on_enter is missing a dispatch.`,
      },
    ];
  }
  const problems: ValidationProblem[] = [];
  if (
    dispatch.payloadWrites != null &&
    !isPlainObject(dispatch.payloadWrites)
  ) {
    problems.push({
      code: 'INVALID_TYPE',
      path: `${path}.dispatch.payload_writes`,
      message: `State '${state.name}' dispatch payload_writes must be an object.`,
    });
  }

  const required = DISPATCH_REQUIRED_ID[dispatch.kind];
  if (!required) {
    const kinds = KNOWN_DISPATCH_KINDS.map((k) => {
      return `'${k}'`;
    }).join(', ');
    problems.push({
      code: 'INVALID_VALUE',
      path: `${path}.dispatch.kind`,
      message: `State '${state.name}' dispatch kind must be one of ${kinds}.`,
    });
  } else if (!isNonEmptyString(dispatch[required.field])) {
    problems.push({
      code: 'MISSING_FIELD',
      path: `${path}.dispatch.${required.wireName}`,
      message: `State '${state.name}' ${dispatch.kind} dispatch is missing ${required.wireName}.`,
    });
  }
  return problems;
};

const stateEntryProblems = (args: {
  state: WorkflowState;
  path: string;
  names: Set<string>;
}): ValidationProblem[] => {
  const { state, path, names } = args;
  const problems: ValidationProblem[] = [];
  if (!isNonEmptyString(state.name)) {
    problems.push({
      code: 'MISSING_FIELD',
      path: `${path}.name`,
      message: 'Every state must have a non-empty `name`.',
    });
  } else if (names.has(state.name)) {
    problems.push({
      code: 'DUPLICATE_NAME',
      path: `${path}.name`,
      message: `Duplicate state name '${state.name}'.`,
    });
  }
  names.add(state.name);

  if (state.kind === 'human' && state.onEnter) {
    problems.push({
      code: 'FIELD_NOT_ALLOWED',
      path: `${path}.on_enter`,
      message: `Human state '${state.name}' cannot declare on_enter automation.`,
    });
  }
  if (
    state.stalledAfter != null &&
    (typeof state.stalledAfter !== 'number' ||
      !Number.isFinite(state.stalledAfter) ||
      state.stalledAfter <= 0)
  ) {
    problems.push({
      code: 'INVALID_VALUE',
      path: `${path}.stalled_after`,
      message: `State '${state.name}' stalled_after must be a positive number of seconds.`,
    });
  }
  if (state.onEnter) {
    problems.push(
      ...onEnterDispatchProblems({ state, path: `${path}.on_enter` }),
      ...retryPolicyProblems({
        stateName: state.name,
        path: `${path}.on_enter.retry`,
        retry: state.onEnter.retry,
      })
    );
  }
  return problems;
};

const stateProblems = (states: WorkflowState[]): ValidationProblem[] => {
  const names = new Set<string>();
  const problems = states.flatMap((state, index) => {
    return stateEntryProblems({ state, path: `states[${index}]`, names });
  });

  const initialCount = states.filter((s) => {
    return s.initial === true;
  }).length;
  if (initialCount !== 1) {
    problems.push({
      code: 'INITIAL_STATE_COUNT',
      path: 'states',
      message: `A workflow must have exactly one initial state (found ${initialCount}).`,
    });
  }
  return problems;
};

const routingProblems = (args: {
  states: WorkflowState[];
  transitionNames: Set<string>;
}): ValidationProblem[] => {
  return args.states.flatMap((state, index) => {
    const onEnter = state.onEnter;
    if (!onEnter) return [];
    const path = `states[${index}].on_enter`;
    const problems: ValidationProblem[] = [];
    for (const [ruleIndex, rule] of (onEnter.onComplete ?? []).entries()) {
      const rulePath = `${path}.on_complete[${ruleIndex}].transition`;
      if (!isNonEmptyString(rule.transition)) {
        problems.push({
          code: 'MISSING_FIELD',
          path: rulePath,
          message: `State '${state.name}' on_complete rule is missing a transition.`,
        });
      } else if (!args.transitionNames.has(rule.transition)) {
        problems.push({
          code: 'UNKNOWN_TRANSITION',
          path: rulePath,
          message: `State '${state.name}' on_complete references unknown transition '${rule.transition}'.`,
        });
      }
    }
    if (
      onEnter.onFailure != null &&
      !args.transitionNames.has(onEnter.onFailure)
    ) {
      problems.push({
        code: 'UNKNOWN_TRANSITION',
        path: `${path}.on_failure`,
        message: `State '${state.name}' on_failure references unknown transition '${onEnter.onFailure}'.`,
      });
    }
    return problems;
  });
};

const transitionStateProblems = (args: {
  transition: WorkflowTransition;
  path: string;
  stateNames: Set<string>;
}): ValidationProblem[] => {
  const { transition: t, path, stateNames } = args;
  const problems: ValidationProblem[] = [];
  if (!Array.isArray(t.from) || t.from.length === 0) {
    problems.push({
      code: 'MISSING_FIELD',
      path: `${path}.from`,
      message: `Transition '${t.name}' must list at least one \`from\` state.`,
    });
  } else {
    for (const [index, from] of t.from.entries()) {
      if (!stateNames.has(from)) {
        problems.push({
          code: 'UNKNOWN_STATE',
          path: `${path}.from[${index}]`,
          message: `Transition '${t.name}' references unknown from-state '${from}'.`,
        });
      }
    }
  }
  if (!stateNames.has(t.to)) {
    problems.push({
      code: 'UNKNOWN_STATE',
      path: `${path}.to`,
      message: `Transition '${t.name}' references unknown to-state '${t.to}'.`,
    });
  }
  if (t.guard != null && typeof t.guard !== 'object') {
    problems.push({
      code: 'INVALID_TYPE',
      path: `${path}.guard`,
      message: `Transition '${t.name}' guard must be a JSON Logic object.`,
    });
  }
  return problems;
};

const transitionProblems = (args: {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}): ValidationProblem[] => {
  if (!Array.isArray(args.transitions)) {
    return [
      {
        code: 'INVALID_TYPE',
        path: 'transitions',
        message: '`transitions` must be an array.',
      },
    ];
  }

  const stateNames = new Set(
    args.states.map((s) => {
      return s.name;
    })
  );
  const transitionNames = new Set<string>();
  const problems = args.transitions.flatMap((t, index) => {
    const path = `transitions[${index}]`;
    const entry: ValidationProblem[] = [];
    if (!isNonEmptyString(t.name)) {
      entry.push({
        code: 'MISSING_FIELD',
        path: `${path}.name`,
        message: 'Every transition must have a non-empty `name`.',
      });
    } else if (transitionNames.has(t.name)) {
      entry.push({
        code: 'DUPLICATE_NAME',
        path: `${path}.name`,
        message: `Duplicate transition name '${t.name}'.`,
      });
    }
    transitionNames.add(t.name);
    return [
      ...entry,
      ...transitionStateProblems({ transition: t, path, stateNames }),
    ];
  });

  return [
    ...problems,
    ...routingProblems({ states: args.states, transitionNames }),
  ];
};

/**
 * Statically validates a workflow definition (§5): unique state names, exactly
 * one initial state, a positive `stalled_after` where present, transitions
 * referencing existing states, well-formed guards, and on_enter automation whose
 * routing targets exist. Throws `WORKFLOW_VALIDATION_FAILED` listing every
 * problem; a definition with no states is refused on that alone, since every
 * other check reads them.
 */
export const assertWorkflowValid = (args: {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}): void => {
  log('assertWorkflowValid: states=%d', args.states?.length ?? 0);
  if (!Array.isArray(args.states) || args.states.length === 0) {
    refuseWorkflow([
      {
        code: 'MISSING_FIELD',
        path: 'states',
        message: 'A workflow must define at least one state.',
      },
    ]);
  }
  const problems = [...stateProblems(args.states), ...transitionProblems(args)];
  if (problems.length > 0) refuseWorkflow(problems);
};

/** The state a new task enters. */
export const initialStateOf = (states: WorkflowState[]): WorkflowState => {
  const initial = states.find((s) => {
    return s.initial === true;
  });
  if (!initial) {
    // Guarded by workflow validation on create/update, so this is defensive.
    return refuseWorkflow([
      {
        code: 'INITIAL_STATE_COUNT',
        path: 'states',
        message: 'Workflow has no initial state.',
      },
    ]);
  }
  return initial;
};
