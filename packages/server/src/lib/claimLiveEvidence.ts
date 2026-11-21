/**
 * The live rules a claim's verdict reads beyond its run (the evaluations
 * module doc — Evidence): the shape of `evidence.live`, and what each rule
 * says about the counts of one agent version's production traffic.
 *
 * Pure: the claims read (`agentVersionClaims.ts`) hands it the counts. The
 * eval's validator and the run's recorded definition both read `evidence.live`
 * through {@link parseLiveEvidence}, so neither checks the shape on its own.
 */
import type { Verdict, VerdictReason } from './evaluationVerdict';
import { isPlainObject } from './plainObject';
import {
  isRollingWindow,
  ROLLING_WINDOWS,
  type RollingWindow,
} from './rollingWindows';

export type LiveEvidence = {
  window: RollingWindow;
  min_served_generations?: number;
  guardrail_tripwires?: { max: number };
  approval_rejections?: { max_rate: number; min_decided: number };
  generation_failures?: { max_rate: number };
};

/** One version's production over a window, as the claims read counts it. */
export type LiveCounts = {
  served: number;
  failed: number;
  tripwires: number;
  decided: number;
  rejected: number;
};

type FieldCheck = { test: (value: unknown) => boolean; expects: string };

const POSITIVE: FieldCheck = {
  test: (value) => {
    return Number.isInteger(value) && Number(value) >= 1;
  },
  expects: 'a positive integer',
};

const COUNT: FieldCheck = {
  test: (value) => {
    return Number.isInteger(value) && Number(value) >= 0;
  },
  expects: 'a non-negative integer',
};

const RATE: FieldCheck = {
  test: (value) => {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    );
  },
  expects: 'a number between 0 and 1',
};

/** The rules that take an object, and the fields each one requires. */
const RULE_FIELDS: Record<string, Record<string, FieldCheck>> = {
  guardrail_tripwires: { max: COUNT },
  approval_rejections: { max_rate: RATE, min_decided: POSITIVE },
  generation_failures: { max_rate: RATE },
};

const WINDOW: FieldCheck = {
  test: isRollingWindow,
  expects: `one of ${ROLLING_WINDOWS.join(', ')}`,
};

const SCALAR_FIELDS: Record<string, FieldCheck> = {
  window: WINDOW,
  min_served_generations: POSITIVE,
};

const ruleProblem = (args: {
  name: string;
  fields: Record<string, FieldCheck>;
  rule: unknown;
}): string | null => {
  const path = `evidence.live.${args.name}`;
  const { rule } = args;
  if (!isPlainObject(rule)) return `${path} must be an object.`;
  const extra = Object.keys(rule).find((key) => {
    return !Object.hasOwn(args.fields, key);
  });
  if (extra !== undefined) return `${path}.${extra} is not a known field.`;
  const wrong = Object.entries(args.fields).find(([key, check]) => {
    return !check.test(rule[key]);
  });
  return wrong ? `${path}.${wrong[0]} must be ${wrong[1].expects}.` : null;
};

const liveProblem = (live: Record<string, unknown>): string | null => {
  const extra = Object.keys(live).find((key) => {
    return (
      !Object.hasOwn(RULE_FIELDS, key) && !Object.hasOwn(SCALAR_FIELDS, key)
    );
  });
  if (extra !== undefined) return `evidence.live.${extra} is not a known rule.`;
  if (live.window === undefined) return 'evidence.live.window is required.';
  for (const [key, check] of Object.entries(SCALAR_FIELDS)) {
    if (live[key] !== undefined && !check.test(live[key])) {
      return `evidence.live.${key} must be ${check.expects}.`;
    }
  }
  for (const [name, fields] of Object.entries(RULE_FIELDS)) {
    if (live[name] === undefined) continue;
    const problem = ruleProblem({ name, fields, rule: live[name] });
    if (problem) return problem;
  }
  return null;
};

const isLiveEvidence = (
  live: Record<string, unknown>
): live is LiveEvidence => {
  return liveProblem(live) === null;
};

/** `evidence.live` read against its rules, or the first problem in it. */
export const parseLiveEvidence = (
  value: unknown
): { live: LiveEvidence } | { problem: string } => {
  if (!isPlainObject(value)) {
    return { problem: 'evidence.live must be an object.' };
  }
  if (!isLiveEvidence(value)) {
    return { problem: String(liveProblem(value)) };
  }
  return { live: value };
};

/** The counts row the claims read's query returns; a missing count is none. */
export const liveCountsOf = (rows: unknown[]): LiveCounts => {
  const [row] = rows;
  const counts = isPlainObject(row) ? row : {};
  const read = (key: keyof LiveCounts): number => {
    return Number(counts[key] ?? 0);
  };
  return {
    served: read('served'),
    failed: read('failed'),
    tripwires: read('tripwires'),
    decided: read('decided'),
    rejected: read('rejected'),
  };
};

const figure = (value: number): string => {
  return String(Math.round(value * 1000) / 1000);
};

type Judgement = { verdict: Verdict; reason: string };

const judgeServed = (args: { min: number; counts: LiveCounts }): Judgement => {
  const { min, counts } = args;
  return counts.served >= min
    ? {
        verdict: 'supported',
        reason: `${counts.served} served, at least ${min}`,
      }
    : {
        verdict: 'insufficient',
        reason: `${counts.served} served, ${min} required`,
      };
};

const judgeTripwires = (args: {
  max: number;
  counts: LiveCounts;
}): Judgement => {
  const { max, counts } = args;
  if (counts.served === 0) {
    return { verdict: 'insufficient', reason: 'nothing served' };
  }
  return counts.tripwires > max
    ? {
        verdict: 'refuted',
        reason: `${counts.tripwires} tripwires, more than ${max}`,
      }
    : {
        verdict: 'supported',
        reason: `${counts.tripwires} tripwires, at most ${max}`,
      };
};

const judgeRate = (args: {
  part: number;
  whole: number;
  maxRate: number;
  label: string;
}): Judgement => {
  const rate = args.part / args.whole;
  return rate > args.maxRate
    ? {
        verdict: 'refuted',
        reason: `${args.label} rate ${figure(rate)} above ${args.maxRate}`,
      }
    : {
        verdict: 'supported',
        reason: `${args.label} rate ${figure(rate)} at or below ${args.maxRate}`,
      };
};

const judgeRejections = (args: {
  rule: { max_rate: number; min_decided: number };
  counts: LiveCounts;
}): Judgement => {
  const { rule, counts } = args;
  if (counts.decided < rule.min_decided) {
    return {
      verdict: 'insufficient',
      reason: `${counts.decided} decided, ${rule.min_decided} required`,
    };
  }
  return judgeRate({
    part: counts.rejected,
    whole: counts.decided,
    maxRate: rule.max_rate,
    label: 'rejection',
  });
};

const judgeFailures = (args: {
  rule: { max_rate: number };
  counts: LiveCounts;
}): Judgement => {
  const { rule, counts } = args;
  if (counts.served === 0) {
    return { verdict: 'insufficient', reason: 'nothing served' };
  }
  return judgeRate({
    part: counts.failed,
    whole: counts.served,
    maxRate: rule.max_rate,
    label: 'failure',
  });
};

/**
 * One reason per rule `live` declares, in this module's fixed order of the
 * rules, whatever order the caller wrote them in.
 */
export const liveReasons = (args: {
  live: LiveEvidence;
  counts: LiveCounts;
}): VerdictReason[] => {
  const { live, counts } = args;
  const judged: Array<[string, Judgement]> = [];
  if (live.min_served_generations !== undefined) {
    judged.push([
      'min_served_generations',
      judgeServed({ min: live.min_served_generations, counts }),
    ]);
  }
  if (live.guardrail_tripwires !== undefined) {
    judged.push([
      'guardrail_tripwires',
      judgeTripwires({ max: live.guardrail_tripwires.max, counts }),
    ]);
  }
  if (live.approval_rejections !== undefined) {
    judged.push([
      'approval_rejections',
      judgeRejections({ rule: live.approval_rejections, counts }),
    ]);
  }
  if (live.generation_failures !== undefined) {
    judged.push([
      'generation_failures',
      judgeFailures({ rule: live.generation_failures, counts }),
    ]);
  }
  return judged.map(([name, judgement]) => {
    return { scope: { kind: 'live', name }, ...judgement };
  });
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the run speaking for a claim is recent enough to stand for it:
 * finished no longer ago than `maxDays` whole days, to the millisecond. A run
 * that recorded no finish time cannot show its age, so it is insufficient.
 */
export const ageReason = (args: {
  maxDays: number;
  finishedAt: Date | null;
  now: Date;
}): VerdictReason => {
  if (args.finishedAt === null) {
    return {
      scope: { kind: 'age' },
      verdict: 'insufficient',
      reason: 'run has no finish time',
    };
  }
  const elapsed = args.now.getTime() - args.finishedAt.getTime();
  const days = Math.floor(elapsed / DAY_MS);
  return {
    scope: { kind: 'age' },
    ...(elapsed > args.maxDays * DAY_MS
      ? {
          verdict: 'insufficient' as const,
          reason: `run finished ${days} days ago, older than ${args.maxDays}`,
        }
      : {
          verdict: 'supported' as const,
          reason: `run finished ${days} days ago, within ${args.maxDays}`,
        }),
  };
};

/**
 * The reason a run's recorded `evidence.live` gives when it no longer reads
 * against the rules: a rule nobody can evaluate is insufficient evidence,
 * never a rule that passed.
 */
export const unreadableLiveReason = (): VerdictReason => {
  return {
    scope: { kind: 'live', name: 'unreadable' },
    verdict: 'insufficient',
    reason:
      'the evidence.live recorded on the run does not read against the rules',
  };
};
