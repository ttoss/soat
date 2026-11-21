import {
  ageReason,
  type LiveCounts,
  liveCountsOf,
  liveReasons,
  parseLiveEvidence,
} from 'src/lib/claimLiveEvidence';
import { isVerdict } from 'src/lib/evaluationVerdict';

/**
 * The live rules a claim reads beyond its run (the evaluations module doc —
 * Evidence): pure functions over counts the claims read already holds, so
 * every boundary is tested here rather than by seeding production rows per
 * case. Their wiring into the claims read is
 * `rest/agentPromotionLiveEvidence.test.ts`.
 */

const counts = (overrides: Partial<LiveCounts> = {}): LiveCounts => {
  return {
    served: 100,
    failed: 0,
    tripwires: 0,
    decided: 0,
    rejected: 0,
    ...overrides,
  };
};

const verdictOf = (args: {
  live: Record<string, unknown>;
  counts: LiveCounts;
  rule: string;
}) => {
  const parsed = parseLiveEvidence(args.live);
  if (!('live' in parsed)) throw new Error(parsed.problem);
  return liveReasons({ live: parsed.live, counts: args.counts }).find(
    (reason) => {
      return reason.scope.kind === 'live' && reason.scope.name === args.rule;
    }
  )?.verdict;
};

describe('claimLiveEvidence', () => {
  describe('parseLiveEvidence', () => {
    test('reads every rule', () => {
      const live = {
        window: '30d',
        min_served_generations: 200,
        guardrail_tripwires: { max: 0 },
        approval_rejections: { max_rate: 0.05, min_decided: 20 },
        generation_failures: { max_rate: 0.01 },
      };
      expect(parseLiveEvidence(live)).toEqual({ live });
    });

    test.each([
      ['a non-object', 'live'],
      ['no window', { guardrail_tripwires: { max: 0 } }],
      ['a window the platform does not serve', { window: '14d' }],
      ['a numeric window', { window: 7 }],
      ['an unknown rule', { window: '7d', exceptions: { max: 0 } }],
      [
        'a negative tripwire max',
        { window: '7d', guardrail_tripwires: { max: -1 } },
      ],
      [
        'an unknown key inside a rule',
        { window: '7d', guardrail_tripwires: { max: 0, min: 1 } },
      ],
      [
        'a rate above 1',
        { window: '7d', generation_failures: { max_rate: 1.5 } },
      ],
      [
        'a rejection rate without min_decided',
        { window: '7d', approval_rejections: { max_rate: 0.1 } },
      ],
      ['min_served_generations 0', { window: '7d', min_served_generations: 0 }],
      ['a rule named after an Object property', { window: '7d', toString: 1 }],
      [
        'a field named after an Object property',
        { window: '7d', guardrail_tripwires: { max: 0, constructor: 1 } },
      ],
    ])('refuses %s', (_label, value) => {
      expect(parseLiveEvidence(value)).toEqual({
        problem: expect.stringContaining('evidence.live'),
      });
    });
  });

  describe('liveReasons', () => {
    test('one reason per declared rule, none for an undeclared one', () => {
      const parsed = parseLiveEvidence({
        window: '7d',
        guardrail_tripwires: { max: 0 },
      });
      if (!('live' in parsed)) throw new Error(parsed.problem);
      expect(liveReasons({ live: parsed.live, counts: counts() })).toEqual([
        {
          scope: { kind: 'live', name: 'guardrail_tripwires' },
          verdict: 'supported',
          reason: expect.any(String),
        },
      ]);
    });

    test.each([
      ['fewer served than required', 199, 'insufficient'],
      ['exactly the required volume', 200, 'supported'],
    ])('min_served_generations: %s', (_label, served, verdict) => {
      expect(
        verdictOf({
          live: { window: '7d', min_served_generations: 200 },
          counts: counts({ served }),
          rule: 'min_served_generations',
        })
      ).toBe(verdict);
    });

    test.each([
      ['one tripwire over a max of 0', { tripwires: 1 }, 'refuted'],
      ['none at a max of 0', { tripwires: 0 }, 'supported'],
      ['nothing served', { served: 0 }, 'insufficient'],
    ])('guardrail_tripwires: %s', (_label, overrides, verdict) => {
      expect(
        verdictOf({
          live: { window: '7d', guardrail_tripwires: { max: 0 } },
          counts: counts(overrides),
          rule: 'guardrail_tripwires',
        })
      ).toBe(verdict);
    });

    test.each([
      ['19 decided under a minimum of 20', { decided: 19 }, 'insufficient'],
      ['a rate above the max', { decided: 20, rejected: 2 }, 'refuted'],
      ['a rate at the max', { decided: 20, rejected: 1 }, 'supported'],
    ])('approval_rejections: %s', (_label, overrides, verdict) => {
      expect(
        verdictOf({
          live: {
            window: '7d',
            approval_rejections: { max_rate: 0.05, min_decided: 20 },
          },
          counts: counts(overrides),
          rule: 'approval_rejections',
        })
      ).toBe(verdict);
    });

    test.each([
      ['a rate above the max', { failed: 2 }, 'refuted'],
      ['a rate at the max', { failed: 1 }, 'supported'],
      ['nothing served', { served: 0 }, 'insufficient'],
    ])('generation_failures: %s', (_label, overrides, verdict) => {
      expect(
        verdictOf({
          live: { window: '7d', generation_failures: { max_rate: 0.01 } },
          counts: counts(overrides),
          rule: 'generation_failures',
        })
      ).toBe(verdict);
    });
  });

  describe('liveCountsOf', () => {
    test('reads the counts Postgres returns as strings', () => {
      expect(
        liveCountsOf([
          {
            served: '3',
            failed: '1',
            tripwires: '2',
            decided: '4',
            rejected: '0',
          },
        ])
      ).toEqual({
        served: 3,
        failed: 1,
        tripwires: 2,
        decided: 4,
        rejected: 0,
      });
    });

    test('reads no row as no traffic', () => {
      expect(liveCountsOf([])).toEqual(counts({ served: 0 }));
    });
  });

  describe('ageReason', () => {
    const now = new Date('2026-11-21T12:00:00Z');
    const daysAgo = (days: number) => {
      return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    };

    test('a run older than the limit is insufficient', () => {
      expect(ageReason({ maxDays: 30, finishedAt: daysAgo(31), now })).toEqual({
        scope: { kind: 'age' },
        verdict: 'insufficient',
        reason: expect.any(String),
      });
    });

    test('a run with no finish time is insufficient and says why', () => {
      expect(ageReason({ maxDays: 30, finishedAt: null, now })).toEqual({
        scope: { kind: 'age' },
        verdict: 'insufficient',
        reason: 'run has no finish time',
      });
    });

    test('a run an hour past the limit is older than it', () => {
      expect(
        ageReason({
          maxDays: 30,
          finishedAt: new Date(daysAgo(30).getTime() - 60 * 60 * 1000),
          now,
        }).verdict
      ).toBe('insufficient');
    });

    test('the reason of a run an hour past the limit reads past the limit', () => {
      expect(
        ageReason({
          maxDays: 30,
          finishedAt: new Date(daysAgo(30).getTime() - 60 * 60 * 1000),
          now,
        }).reason
      ).toBe('run finished 30.042 days ago, older than 30');
    });

    test('a run exactly at the limit is supported', () => {
      expect(
        ageReason({ maxDays: 30, finishedAt: daysAgo(30), now })?.verdict
      ).toBe('supported');
    });

    test('a run within the limit is supported', () => {
      expect(
        ageReason({ maxDays: 30, finishedAt: daysAgo(29), now })?.verdict
      ).toBe('supported');
    });
  });

  describe('isVerdict', () => {
    test('reads only the three verdicts, never an Object property', () => {
      expect(isVerdict('supported')).toBe(true);
      expect(isVerdict('toString')).toBe(false);
      expect(isVerdict('constructor')).toBe(false);
    });
  });
});
