/**
 * An eval's `criteria` (the evaluations module doc — Criteria): the construct
 * as an object. Every scorer sits in exactly one criterion, each criterion is
 * defined by probes that pass and fail, and a run judges each criterion on its
 * own interval.
 *
 * Pure: the eval writes validate through it and the finalizer rolls results
 * up through it.
 */
import type { ComparableResult } from './evaluationDeltas';
import { scorerOutcomeKey } from './evaluationScorerValidation';
import { type PassRateInterval, wilsonInterval } from './evaluationStatistics';
import { isPlainObject } from './plainObject';

export type CriterionRollup = {
  pass_rate: number | null;
  pass_rate_interval: PassRateInterval | null;
  scored_item_count: number;
};

const CRITERION_FIELDS = new Set(['name', 'description', 'scorers', 'probes']);
const PROBE_FIELDS = new Set([
  'output',
  'object',
  'metadata',
  'passed',
  'note',
  'input',
  'expected_output',
]);

const unknownField = (args: {
  value: Record<string, unknown>;
  allowed: Set<string>;
  path: string;
}): string | null => {
  const extra = Object.keys(args.value).find((key) => {
    return !args.allowed.has(key);
  });
  return extra === undefined
    ? null
    : `${args.path}.${extra} is not a known field.`;
};

const optionalProbeFieldProblem = (args: {
  probe: Record<string, unknown>;
  path: string;
}): string | null => {
  const { probe, path } = args;
  if (probe.note !== undefined && typeof probe.note !== 'string') {
    return `${path}.note must be a string.`;
  }
  if (probe.metadata !== undefined && !isPlainObject(probe.metadata)) {
    return `${path}.metadata must be an object.`;
  }
  const expected = probe.expected_output;
  if (
    expected !== undefined &&
    expected !== null &&
    typeof expected !== 'string'
  ) {
    return `${path}.expected_output must be a string or null.`;
  }
  return null;
};

const probeProblem = (args: {
  probe: unknown;
  path: string;
}): string | null => {
  const { probe, path } = args;
  if (!isPlainObject(probe)) return `${path} must be an object.`;
  const unknown = unknownField({ value: probe, allowed: PROBE_FIELDS, path });
  if (unknown) return unknown;
  if (typeof probe.output !== 'string') {
    return `${path}.output is required and must be a string.`;
  }
  if (typeof probe.passed !== 'boolean') {
    return `${path}.passed is required and must be a boolean.`;
  }
  return optionalProbeFieldProblem({ probe, path });
};

const probesProblem = (args: {
  probes: unknown;
  path: string;
}): string | null => {
  const { probes, path } = args;
  if (!Array.isArray(probes)) return `${path} must be an array.`;
  for (const [index, probe] of probes.entries()) {
    const problem = probeProblem({ probe, path: `${path}.${index}` });
    if (problem) return problem;
  }
  const passes = probes.filter((probe) => {
    return isPlainObject(probe) && probe.passed === true;
  });
  if (passes.length === 0 || passes.length === probes.length) {
    return `${path} needs at least one probe that passes and one that fails.`;
  }
  return null;
};

/** Where each scorer sits so far, by name: the path of its criterion. */
type Placement = Map<string, string>;

const scorersProblem = (args: {
  scorers: unknown;
  path: string;
  criterionPath: string;
  scorerKeys: ReadonlySet<string>;
  placed: Placement;
}): string | null => {
  const { scorers, path } = args;
  if (!Array.isArray(scorers) || scorers.length === 0) {
    return `${path} must name at least one scorer.`;
  }
  for (const name of scorers) {
    if (typeof name !== 'string') return `${path} must name scorers by name.`;
    if (!args.scorerKeys.has(name)) {
      return `${path} names '${name}', which no scorer of the eval is named.`;
    }
    const holder = args.placed.get(name);
    if (holder !== undefined) {
      return `${path} names '${name}', which ${holder} already holds; each scorer sits in exactly one criterion.`;
    }
    args.placed.set(name, args.criterionPath);
  }
  return null;
};

const criterionProblem = (args: {
  criterion: unknown;
  path: string;
  scorerKeys: ReadonlySet<string>;
  names: Set<string>;
  placed: Placement;
}): string | null => {
  const { criterion, path } = args;
  if (!isPlainObject(criterion)) return `${path} must be an object.`;
  const unknown = unknownField({
    value: criterion,
    allowed: CRITERION_FIELDS,
    path,
  });
  if (unknown) return unknown;
  const { name, description } = criterion;
  if (typeof name !== 'string' || name.trim() === '') {
    return `${path}.name is required and must be a non-empty string.`;
  }
  if (args.names.has(name)) {
    return `${path}.name '${name}' is declared more than once; each criterion name may appear at most once per eval.`;
  }
  args.names.add(name);
  if (typeof description !== 'string' || description.trim() === '') {
    return `${path}.description is required and must be a non-empty string.`;
  }
  return (
    scorersProblem({
      scorers: criterion.scorers,
      path: `${path}.scorers`,
      criterionPath: path,
      scorerKeys: args.scorerKeys,
      placed: args.placed,
    }) ?? probesProblem({ probes: criterion.probes, path: `${path}.probes` })
  );
};

/**
 * The first problem with `criteria` against the eval's scorers, or
 * `null`: no criteria (`null` or absent) is valid, and an eval with criteria
 * places every scorer in exactly one of them.
 */
export const validateCriteria = (args: {
  criteria: unknown;
  scorers: unknown;
}): string | null => {
  if (args.criteria === undefined || args.criteria === null) return null;
  if (!Array.isArray(args.criteria) || args.criteria.length === 0) {
    return 'criteria must be a non-empty array, or null for none.';
  }
  const keys = (Array.isArray(args.scorers) ? args.scorers : []).flatMap(
    (scorer) => {
      return isPlainObject(scorer) ? [scorerOutcomeKey(scorer)] : [];
    }
  );
  const scorerKeys = new Set(keys);
  const names = new Set<string>();
  const placed: Placement = new Map();
  for (const [index, criterion] of args.criteria.entries()) {
    const problem = criterionProblem({
      criterion,
      path: `criteria.${index}`,
      scorerKeys,
      names,
      placed,
    });
    if (problem) return problem;
  }
  const unplaced = keys.find((key) => {
    return !placed.has(key);
  });
  return unplaced === undefined
    ? null
    : `Scorer '${unplaced}' sits in no criterion; each scorer sits in exactly one.`;
};

/**
 * A criterion as a run reads it: its name, the scorers it binds, and its
 * probes as written (`evaluationProbes.ts` reads them).
 */
type CriterionBinding = { name: string; scorers: string[]; probes: unknown };

/** The criteria a definition recorded, read for their bindings; `[]` for none. */
export const criterionBindings = (criteria: unknown): CriterionBinding[] => {
  if (!Array.isArray(criteria)) return [];
  return criteria.flatMap((criterion) => {
    if (!isPlainObject(criterion) || typeof criterion.name !== 'string') {
      return [];
    }
    const scorers = Array.isArray(criterion.scorers)
      ? criterion.scorers.filter((name): name is string => {
          return typeof name === 'string';
        })
      : [];
    return [{ name: criterion.name, scorers, probes: criterion.probes }];
  });
};

/**
 * Each criterion over the scored items: an item passes a criterion when every
 * scorer the criterion binds passed it. Errored items say nothing about the
 * agent and are left out, as the run's own rollup leaves them.
 */
export const criterionRollups = (args: {
  criteria: unknown;
  results: ComparableResult[];
}): Record<string, CriterionRollup> | undefined => {
  const bindings = criterionBindings(args.criteria);
  if (bindings.length === 0) return undefined;
  const scored = args.results.filter((result) => {
    return !result.errored;
  });
  const rollups: Record<string, CriterionRollup> = {};
  for (const { name, scorers } of bindings) {
    const passed = scored.filter((result) => {
      return scorers.every((scorer) => {
        return result.scores.some((outcome) => {
          return outcome.scorer === scorer && outcome.passed;
        });
      });
    }).length;
    rollups[name] = {
      pass_rate: scored.length === 0 ? null : passed / scored.length,
      pass_rate_interval: wilsonInterval({ passed, total: scored.length }),
      scored_item_count: scored.length,
    };
  }
  return rollups;
};
