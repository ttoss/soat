import type { AttachedGuardrail } from '../../../../src/lib/guardrailEvaluation';
import {
  composeGuardrailDecision,
  evaluateGuardrail,
  strictestDecision,
} from '../../../../src/lib/guardrailEvaluation';

const attach = (
  document: AttachedGuardrail['document'],
  overrides: Partial<AttachedGuardrail> = {}
): AttachedGuardrail => {
  return {
    guardrailId: 'guard_test',
    version: 1,
    scope: 'tool',
    document,
    ...overrides,
  };
};

describe('guardrailEvaluation', () => {
  describe('evaluateGuardrail — literal classes', () => {
    test('class A always executes', () => {
      const result = evaluateGuardrail({
        guardrail: attach({ class: 'A' }),
        context: {},
      });
      expect(result.class).toBe('A');
      expect(result.decision).toBe('execute');
      expect(result.guardResult).toBeNull();
    });

    test('class C routes to approval', () => {
      const result = evaluateGuardrail({
        guardrail: attach({ class: 'C' }),
        context: {},
      });
      expect(result.class).toBe('C');
      expect(result.decision).toBe('route_to_approval');
      expect(result.guardResult).toBeNull();
    });

    test('class D is blocked', () => {
      const result = evaluateGuardrail({
        guardrail: attach({ class: 'D' }),
        context: {},
      });
      expect(result.class).toBe('D');
      expect(result.decision).toBe('blocked');
      expect(result.guardResult).toBeNull();
    });
  });

  describe('evaluateGuardrail — class B and guards', () => {
    test('class B with a passing guard executes', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: { '<': [{ var: 'args.amount' }, 500] },
        }),
        context: { args: { amount: 100 } },
      });
      expect(result.class).toBe('B');
      expect(result.decision).toBe('execute');
      expect(result.guardResult).toBe(true);
    });

    test('class B with a failing guard trips (tripwire) by default', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: { '<': [{ var: 'args.amount' }, 500] },
        }),
        context: { args: { amount: 900 } },
      });
      expect(result.class).toBe('B');
      expect(result.decision).toBe('tripwire');
      expect(result.guardResult).toBe(false);
    });

    test('class B with a failing guard routes to approval when escalate is true', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: { '<': [{ var: 'args.amount' }, 500] },
          escalate: true,
        }),
        context: { args: { amount: 900 } },
      });
      expect(result.decision).toBe('route_to_approval');
      expect(result.guardResult).toBe(false);
    });

    test('class B with no guard fails closed (tripwire)', () => {
      const result = evaluateGuardrail({
        guardrail: attach({ class: 'B' }),
        context: {},
      });
      expect(result.class).toBe('B');
      expect(result.decision).toBe('tripwire');
      expect(result.guardResult).toBe(false);
    });

    test('a guard referencing a missing context key fails closed', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: {
            '<=': [{ var: 'args.amount' }, { var: 'context.max_daily_budget' }],
          },
        }),
        // context.max_daily_budget absent → var resolves null → guard false
        context: { args: { amount: 100 } },
      });
      expect(result.decision).toBe('tripwire');
      expect(result.guardResult).toBe(false);
    });

    test('a guard reads soat.* from the soat namespace', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
        }),
        context: { soat: { usage: { cost_usd_24h: 812.4 } } },
      });
      expect(result.decision).toBe('execute');
      expect(result.guardResult).toBe(true);
    });

    // The document is authored against the snake_case external contract (like
    // every OpenAPI field and the soat.* catalog), but the caller's args /
    // guardrail_context reach evaluation camelCased by the caseTransform
    // middleware. A snake_case var path must still resolve — otherwise the
    // canonical budget example in guardrails.md hard-stops every class-B call.
    test('a snake_case context var path resolves against a camelCased runtime key', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: {
            '<=': [{ var: 'args.amount' }, { var: 'context.max_daily_budget' }],
          },
        }),
        // runtime keys are camelCased before reaching evaluation
        context: { args: { amount: 100 }, context: { maxDailyBudget: 500 } },
      });
      expect(result.decision).toBe('execute');
      expect(result.guardResult).toBe(true);
    });

    test('a snake_case args var path resolves against a camelCased runtime key', () => {
      // `>` (not `<`) so a *failure* to resolve (null → coerced 0) would take the
      // opposite branch — the assertion only holds if the alias truly resolves.
      const result = evaluateGuardrail({
        guardrail: attach({
          class: {
            if: [{ '>': [{ var: 'args.daily_amount' }, 50] }, 'B', 'C'],
          },
          guard: { '>': [{ var: 'args.daily_amount' }, 50] },
        }),
        context: { args: { dailyAmount: 100 } },
      });
      expect(result.class).toBe('B');
      expect(result.decision).toBe('execute');
      expect(result.guardResult).toBe(true);
    });

    test('a camelCase var path still resolves against a camelCased runtime key', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          class: 'B',
          guard: {
            '<=': [{ var: 'args.amount' }, { var: 'context.maxDailyBudget' }],
          },
        }),
        context: { args: { amount: 100 }, context: { maxDailyBudget: 500 } },
      });
      expect(result.decision).toBe('execute');
      expect(result.guardResult).toBe(true);
    });
  });

  describe('evaluateGuardrail — class expressions and fail-closed default', () => {
    test('a class expression resolves the class from args', () => {
      const document = {
        default_class: 'C' as const,
        class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
        guard: { '<': [{ var: 'args.amount' }, 500] },
      };
      const below = evaluateGuardrail({
        guardrail: attach(document),
        context: { args: { amount: 100 } },
      });
      expect(below.class).toBe('B');
      expect(below.decision).toBe('execute');

      const atOrAbove = evaluateGuardrail({
        guardrail: attach(document),
        context: { args: { amount: 500 } },
      });
      expect(atOrAbove.class).toBe('C');
      expect(atOrAbove.decision).toBe('route_to_approval');
    });

    test('an invalid class result resolves to default_class', () => {
      const result = evaluateGuardrail({
        guardrail: attach({
          default_class: 'D',
          // var missing → null → not a valid class → default_class
          class: { var: 'args.nope' },
        }),
        context: {},
      });
      expect(result.class).toBe('D');
      expect(result.decision).toBe('blocked');
    });

    test('an invalid class result with no default_class falls to C (fail-closed)', () => {
      const result = evaluateGuardrail({
        guardrail: attach({ class: { var: 'args.nope' } }),
        context: {},
      });
      expect(result.class).toBe('C');
      expect(result.decision).toBe('route_to_approval');
    });
  });

  describe('strictestDecision ordering', () => {
    test('blocked > tripwire > route_to_approval > execute', () => {
      expect(strictestDecision('execute', 'route_to_approval')).toBe(
        'route_to_approval'
      );
      expect(strictestDecision('route_to_approval', 'tripwire')).toBe(
        'tripwire'
      );
      expect(strictestDecision('tripwire', 'blocked')).toBe('blocked');
      expect(strictestDecision('blocked', 'execute')).toBe('blocked');
      expect(strictestDecision('execute', 'execute')).toBe('execute');
    });
  });

  describe('composeGuardrailDecision — stricter-wins', () => {
    test('no guardrails means execute', () => {
      const composed = composeGuardrailDecision({
        guardrails: [],
        context: {},
      });
      expect(composed.decision).toBe('execute');
      expect(composed.evaluations).toHaveLength(0);
    });

    test('an A defers to a C (stricter wins)', () => {
      const composed = composeGuardrailDecision({
        guardrails: [
          attach({ class: 'A' }, { scope: 'agent', guardrailId: 'guard_a' }),
          attach({ class: 'C' }, { scope: 'tool', guardrailId: 'guard_c' }),
        ],
        context: {},
      });
      expect(composed.decision).toBe('route_to_approval');
      expect(composed.evaluations).toHaveLength(2);
    });

    test('a failing B guard wins over a passing B (guards-AND)', () => {
      const composed = composeGuardrailDecision({
        guardrails: [
          attach(
            { class: 'B', guard: { '<': [{ var: 'args.amount' }, 500] } },
            { guardrailId: 'guard_pass' }
          ),
          attach(
            { class: 'B', guard: { '<': [{ var: 'args.amount' }, 50] } },
            { guardrailId: 'guard_fail' }
          ),
        ],
        context: { args: { amount: 100 } },
      });
      expect(composed.decision).toBe('tripwire');
    });

    test('a blocked (D) wins over a route_to_approval (C)', () => {
      const composed = composeGuardrailDecision({
        guardrails: [
          attach({ class: 'C' }, { scope: 'project', guardrailId: 'guard_c' }),
          attach({ class: 'D' }, { scope: 'tool', guardrailId: 'guard_d' }),
        ],
        context: {},
      });
      expect(composed.decision).toBe('blocked');
    });

    test('a tripwire outranks a route_to_approval across guardrails', () => {
      const composed = composeGuardrailDecision({
        guardrails: [
          // escalating B whose guard fails → route_to_approval
          attach(
            {
              class: 'B',
              guard: { '<': [{ var: 'args.amount' }, 50] },
              escalate: true,
            },
            { guardrailId: 'guard_escalate' }
          ),
          // non-escalating B whose guard fails → tripwire (hard stop)
          attach(
            { class: 'B', guard: { '<': [{ var: 'args.amount' }, 50] } },
            { guardrailId: 'guard_hard' }
          ),
        ],
        context: { args: { amount: 100 } },
      });
      expect(composed.decision).toBe('tripwire');
    });
  });
});
