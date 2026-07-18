import { DomainError } from 'src/errors';
import {
  assertWorkflowValid,
  findValidTransition,
  validatePayload,
  type WorkflowState,
  type WorkflowTransition,
} from 'src/lib/workflowsValidation';

const states: WorkflowState[] = [
  { name: 'a', initial: true },
  { name: 'b' },
  { name: 'c', terminal: true },
];
const transitions: WorkflowTransition[] = [
  { name: 'go', from: ['a'], to: 'b' },
  { name: 'back', from: ['b'], to: 'a' },
  { name: 'done', from: ['b'], to: 'c' },
];

const expectInvalid = (
  args: { states: WorkflowState[]; transitions: WorkflowTransition[] },
  match?: RegExp
) => {
  try {
    assertWorkflowValid(args);
    throw new Error('expected assertWorkflowValid to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('WORKFLOW_VALIDATION_FAILED');
    if (match) expect((error as DomainError).message).toMatch(match);
  }
};

describe('assertWorkflowValid', () => {
  test('accepts a well-formed definition with a cycle (a→b→a)', () => {
    expect(() => {
      return assertWorkflowValid({ states, transitions });
    }).not.toThrow();
  });

  test('rejects an empty state list', () => {
    expectInvalid({ states: [], transitions: [] }, /at least one state/);
  });

  test('rejects duplicate state names', () => {
    expectInvalid(
      {
        states: [{ name: 'a', initial: true }, { name: 'a' }],
        transitions: [],
      },
      /Duplicate state/
    );
  });

  test('rejects zero initial states', () => {
    expectInvalid(
      { states: [{ name: 'a' }, { name: 'b' }], transitions: [] },
      /exactly one initial/
    );
  });

  test('rejects more than one initial state', () => {
    expectInvalid(
      {
        states: [
          { name: 'a', initial: true },
          { name: 'b', initial: true },
        ],
        transitions: [],
      },
      /exactly one initial/
    );
  });

  test('rejects a transition to an unknown state', () => {
    expectInvalid(
      {
        states: [{ name: 'a', initial: true }],
        transitions: [{ name: 'go', from: ['a'], to: 'ghost' }],
      },
      /unknown to-state/
    );
  });

  test('rejects a transition from an unknown state', () => {
    expectInvalid(
      {
        states: [{ name: 'a', initial: true }],
        transitions: [{ name: 'go', from: ['ghost'], to: 'a' }],
      },
      /unknown from-state/
    );
  });

  test('rejects a human state that declares on_enter automation', () => {
    expectInvalid(
      {
        states: [
          {
            name: 'a',
            initial: true,
            kind: 'human',
            onEnter: { dispatch: { kind: 'agent', agentId: 'agent_x' } },
          },
        ],
        transitions: [],
      },
      /Human state/
    );
  });

  test('rejects an agent dispatch missing agent_id', () => {
    expectInvalid(
      {
        states: [
          {
            name: 'a',
            initial: true,
            onEnter: { dispatch: { kind: 'agent' } },
          },
        ],
        transitions: [],
      },
      /missing agent_id/
    );
  });

  test('rejects on_complete referencing an unknown transition', () => {
    expectInvalid(
      {
        states: [
          {
            name: 'a',
            initial: true,
            onEnter: {
              dispatch: { kind: 'agent', agentId: 'agent_x' },
              onComplete: [{ when: true, transition: 'ghost' }],
            },
          },
          { name: 'b' },
        ],
        transitions: [{ name: 'go', from: ['a'], to: 'b' }],
      },
      /unknown transition/
    );
  });
});

describe('findValidTransition', () => {
  test('returns the transition when valid from the given state', () => {
    expect(
      findValidTransition({ transitions, name: 'go', fromState: 'a' })?.to
    ).toBe('b');
  });

  test('returns null when the name is unknown', () => {
    expect(
      findValidTransition({ transitions, name: 'nope', fromState: 'a' })
    ).toBeNull();
  });

  test('returns null when not valid from the given state', () => {
    expect(
      findValidTransition({ transitions, name: 'go', fromState: 'b' })
    ).toBeNull();
  });
});

describe('validatePayload', () => {
  const schema = {
    required: ['topic'],
    properties: { topic: { type: 'string' }, priority: { type: 'integer' } },
  };

  test('passes a payload that satisfies the schema', () => {
    expect(() => {
      return validatePayload({
        payloadSchema: schema,
        payload: { topic: 'x', priority: 3 },
      });
    }).not.toThrow();
  });

  test('is a no-op when no schema is present', () => {
    expect(() => {
      return validatePayload({ payloadSchema: null, payload: { anything: 1 } });
    }).not.toThrow();
  });

  test('rejects a missing required field', () => {
    try {
      validatePayload({ payloadSchema: schema, payload: { priority: 1 } });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as DomainError).code).toBe('TASK_PAYLOAD_INVALID');
      expect((error as DomainError).message).toMatch(/topic/);
    }
  });

  test('rejects a type mismatch', () => {
    try {
      validatePayload({
        payloadSchema: schema,
        payload: { topic: 'x', priority: 'high' },
      });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as DomainError).code).toBe('TASK_PAYLOAD_INVALID');
      expect((error as DomainError).message).toMatch(/priority/);
    }
  });
});
