import { DomainError } from 'src/errors';
import {
  assertWorkflowValid,
  findValidTransition,
  validatePayload,
  workflowCollectionToCamel,
  workflowCollectionToSnake,
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

// #852 — the wire↔internal conversion must be an explicit field-by-field
// mapper, not a key-blind recursive transform: only the named structural keys
// change case, and every author-owned value — JSON Logic bodies, mapping
// bags, and any key the mapper does not name — is copied verbatim, so its
// inner keys can never be rewritten.
describe('workflowCollectionToCamel / workflowCollectionToSnake', () => {
  test('renames the structural keys and leaves author-owned bags verbatim', () => {
    const wire = [
      {
        name: 'triage',
        initial: true,
        stalled_after: 60,
        on_enter: {
          dispatch: {
            kind: 'orchestration',
            orchestration_id: 'orc_1',
            input_mapping: {
              customer_id: { var: 'task.payload.customer_id' },
            },
            payload_writes: {
              review_notes: { var: 'result.output.review_notes' },
            },
          },
          retry: { max_attempts: 3, backoff_seconds: 5 },
          on_complete: [
            { when: { missing_some: [1, ['a_b', 'c_d']] }, transition: 'go' },
          ],
          on_failure: 'fail',
        },
      },
    ];

    const camel = workflowCollectionToCamel<WorkflowState>(wire)!;
    const state = camel[0] as WorkflowState & Record<string, unknown>;

    expect(state.stalledAfter).toBe(60);
    expect(state).not.toHaveProperty('stalled_after');
    expect(state.onEnter?.dispatch.orchestrationId).toBe('orc_1');
    expect(state.onEnter?.retry).toEqual({ maxAttempts: 3, backoffSeconds: 5 });
    expect(state.onEnter?.onFailure).toBe('fail');
    // Author-owned bags round through untouched, inner keys included.
    expect(state.onEnter?.dispatch.inputMapping).toEqual({
      customer_id: { var: 'task.payload.customer_id' },
    });
    expect(state.onEnter?.dispatch.payloadWrites).toEqual({
      review_notes: { var: 'result.output.review_notes' },
    });
    expect(state.onEnter?.onComplete?.[0].when).toEqual({
      missing_some: [1, ['a_b', 'c_d']],
    });
  });

  test('a transition guard is opaque; requires_approval is renamed', () => {
    const camel = workflowCollectionToCamel<WorkflowTransition>([
      {
        name: 'go',
        from: ['a'],
        to: 'b',
        requires_approval: true,
        guard: { '==': [{ var: 'task.payload.review_state' }, 'ok'] },
      },
    ])!;

    expect(camel[0].requiresApproval).toBe(true);
    expect(camel[0].guard).toEqual({
      '==': [{ var: 'task.payload.review_state' }, 'ok'],
    });
  });

  test('an unrecognized key is copied verbatim, never deep-rewritten (the deepConvertKeys regression)', () => {
    const wire = [
      {
        name: 'a',
        future_bag: { inner_key: { deep_key: 1 } },
      },
    ];

    const camel = workflowCollectionToCamel<Record<string, unknown>>(wire)!;
    // The mapper does not know `future_bag`, so it must not touch it — not
    // its name, and above all not its inner keys. deepConvertKeys rewrote
    // both unless someone remembered to extend a skip list.
    expect(camel[0]).toHaveProperty('future_bag');
    expect(camel[0].future_bag).toEqual({ inner_key: { deep_key: 1 } });

    const snake = workflowCollectionToSnake(camel) as Record<string, unknown>[];
    expect(snake[0].future_bag).toEqual({ inner_key: { deep_key: 1 } });
  });

  test('toSnake reverses toCamel exactly for a full workflow definition', () => {
    const wire = [
      {
        name: 'triage',
        stalled_after: 120,
        on_enter: {
          dispatch: {
            kind: 'agent',
            agent_id: 'agt_1',
            input_mapping: { some_key: 'x' },
          },
          retry: {
            max_attempts: 2,
            backoff_seconds: 1,
            backoff_multiplier: 2,
          },
          on_complete: [{ when: { var: 'result.ok' }, transition: 'go' }],
          on_failure: null,
        },
      },
      { name: 'done', terminal: true },
    ];

    expect(workflowCollectionToSnake(workflowCollectionToCamel(wire))).toEqual(
      wire
    );
  });
});

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

  test('rejects a dispatch payload_writes that is not an object', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"agent","agentId":"agent_x","payloadWrites":"nope"}}}],"transitions":[]}'
      ),
      /payload_writes must be an object/
    );
  });

  test('accepts an on_enter retry policy', () => {
    expect(() => {
      return assertWorkflowValid({
        states: [
          {
            name: 'a',
            initial: true,
            onEnter: {
              dispatch: { kind: 'agent', agentId: 'agent_x' },
              retry: {
                maxAttempts: 3,
                backoffSeconds: 5,
                backoffMultiplier: 2,
              },
            },
          },
        ],
        transitions: [],
      });
    }).not.toThrow();
  });

  test('rejects a retry policy that is not an object', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"agent","agentId":"agent_x"},"retry":"nope"}}],"transitions":[]}'
      ),
      /retry must be an object/
    );
  });

  test('rejects a retry max_attempts that is not a positive integer', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"agent","agentId":"agent_x"},"retry":{"maxAttempts":0}}}],"transitions":[]}'
      ),
      /retry max_attempts must be an integer/
    );
  });

  test('rejects a retry max_attempts above the cap', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"agent","agentId":"agent_x"},"retry":{"maxAttempts":99}}}],"transitions":[]}'
      ),
      /retry max_attempts must be an integer/
    );
  });

  test('rejects a negative retry backoff_seconds', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"agent","agentId":"agent_x"},"retry":{"maxAttempts":2,"backoffSeconds":-1}}}],"transitions":[]}'
      ),
      /retry backoff_seconds must be a number/
    );
  });

  test('rejects a retry backoff_multiplier below 1', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"agent","agentId":"agent_x"},"retry":{"maxAttempts":2,"backoffMultiplier":0.5}}}],"transitions":[]}'
      ),
      /retry backoff_multiplier must be a number/
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

  test('rejects an orchestration dispatch missing orchestration_id', () => {
    expectInvalid(
      {
        states: [
          {
            name: 'a',
            initial: true,
            onEnter: { dispatch: { kind: 'orchestration' } },
          },
        ],
        transitions: [],
      },
      /missing orchestration_id/
    );
  });

  test('rejects an on_complete rule with an empty transition name', () => {
    expectInvalid(
      {
        states: [
          {
            name: 'a',
            initial: true,
            onEnter: {
              dispatch: { kind: 'agent', agentId: 'agent_x' },
              onComplete: [{ when: true, transition: '' }],
            },
          },
          { name: 'b' },
        ],
        transitions: [{ name: 'go', from: ['a'], to: 'b' }],
      },
      /missing a transition/
    );
  });

  test('rejects on_failure referencing an unknown transition', () => {
    expectInvalid(
      {
        states: [
          {
            name: 'a',
            initial: true,
            onEnter: {
              dispatch: { kind: 'agent', agentId: 'agent_x' },
              onFailure: 'ghost',
            },
          },
          { name: 'b' },
        ],
        transitions: [{ name: 'go', from: ['a'], to: 'b' }],
      },
      /on_failure references unknown transition/
    );
  });

  test('rejects a transition with an empty from list', () => {
    expectInvalid(
      { states, transitions: [{ name: 'go', from: [], to: 'b' }] },
      /at least one/
    );
  });

  test('rejects a guard that is not an object', () => {
    expectInvalid(
      {
        states,
        transitions: [{ name: 'go', from: ['a'], to: 'b', guard: 'nope' }],
      },
      /guard must be a JSON Logic object/
    );
  });

  test('rejects a transition with an empty name', () => {
    expectInvalid(
      { states, transitions: [{ name: '', from: ['a'], to: 'b' }] },
      /transition must have a non-empty/
    );
  });

  test('rejects a duplicate transition name', () => {
    expectInvalid(
      {
        states,
        transitions: [
          { name: 'go', from: ['a'], to: 'b' },
          { name: 'go', from: ['b'], to: 'c' },
        ],
      },
      /Duplicate transition/
    );
  });

  // The API accepts arbitrary JSON for states/transitions, so these guards
  // defend against untyped input — exercised here with parsed JSON rather than
  // typed literals to mirror what the request body actually delivers.
  test('rejects a non-human state whose on_enter has no dispatch', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{}}],"transitions":[]}'
      ),
      /missing a dispatch/
    );
  });

  test('rejects a dispatch with an unknown kind', () => {
    expectInvalid(
      JSON.parse(
        '{"states":[{"name":"a","initial":true,"onEnter":{"dispatch":{"kind":"weird"}}}],"transitions":[]}'
      ),
      /dispatch kind must be/
    );
  });

  test('accepts a transition declaring requires_approval: true (Phase 3)', () => {
    expect(() => {
      return assertWorkflowValid({
        states,
        transitions: [
          { name: 'go', from: ['a'], to: 'b', requiresApproval: true },
        ],
      });
    }).not.toThrow();
  });

  test('accepts a transition with requires_approval: false', () => {
    expect(() => {
      return assertWorkflowValid({
        states,
        transitions: [
          { name: 'go', from: ['a'], to: 'b', requiresApproval: false },
        ],
      });
    }).not.toThrow();
  });

  test('rejects a non-positive stalled_after', () => {
    expectInvalid(
      {
        states: [{ name: 'a', initial: true, stalledAfter: 0 }, { name: 'b' }],
        transitions: [{ name: 'go', from: ['a'], to: 'b' }],
      },
      /stalled_after must be a positive number/
    );
  });

  test('accepts a positive stalled_after', () => {
    expect(() => {
      return assertWorkflowValid({
        states: [{ name: 'a', initial: true, stalledAfter: 60 }, { name: 'b' }],
        transitions: [{ name: 'go', from: ['a'], to: 'b' }],
      });
    }).not.toThrow();
  });

  test('rejects a transitions value that is not an array', () => {
    expectInvalid(
      JSON.parse('{"states":[{"name":"a","initial":true}],"transitions":{}}'),
      /must be an array/
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
