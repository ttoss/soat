/**
 * Probes (the evaluations module doc — Criteria): each criterion's fixed
 * outputs, graded by the criterion's scorers. A probe holds when the
 * criterion's verdict on it — every scorer it binds passed — is the one the
 * probe declares. Run before a run's first item and by the dry-run route,
 * never by an eval write (no write calls a model).
 *
 * The scorers' runners are injected, as for an item, so the calls are metered
 * and authorized as the run's would be.
 */
import createDebug from 'debug';

import { scoringFailure } from './evaluationRunExecution';
import { scoreOutput, type ScorerOutcome } from './evaluationScorers';
import { scorerOutcomeKey } from './evaluationScorerValidation';
import { isPlainObject } from './plainObject';
import type { StoredError } from './storedError';

const log = createDebug('soat:evaluations');

export type ProbeResult = {
  criterion: string;
  index: number;
  /** The verdict the probe declares. */
  expected: boolean;
  /** The criterion's verdict on it: every scorer it binds passed. */
  passed: boolean;
  held: boolean;
  scores: ScorerOutcome[];
  /** Why the scorers could not grade it; the probe does not hold then. */
  error?: StoredError;
};

export type ProbeReport = { passed: boolean; probes: ProbeResult[] };

type ScoreArgs = Parameters<typeof scoreOutput>[0];

/** The scorer runners an item is graded with. */
export type ProbeRunners = Pick<
  ScoreArgs,
  'runJudge' | 'runToolScorer' | 'runEmbeddings' | 'runDecider'
>;

type Probe = {
  output: string;
  passed: boolean;
  input: unknown;
  expectedOutput: string | null;
};

type CriterionProbes = { name: string; scorers: unknown[]; probes: Probe[] };

const probesOf = (value: unknown): Probe[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((probe) => {
    if (!isPlainObject(probe) || typeof probe.output !== 'string') return [];
    return [
      {
        output: probe.output,
        passed: probe.passed === true,
        input: probe.input ?? null,
        expectedOutput:
          typeof probe.expected_output === 'string'
            ? probe.expected_output
            : null,
      },
    ];
  });
};

/** Each criterion with the scorer configurations it binds and its probes. */
const criterionProbes = (args: {
  criteria: unknown;
  scorers: unknown[];
}): CriterionProbes[] => {
  if (!Array.isArray(args.criteria)) return [];
  return args.criteria.flatMap((criterion) => {
    if (!isPlainObject(criterion) || typeof criterion.name !== 'string') {
      return [];
    }
    const bound = new Set(
      Array.isArray(criterion.scorers) ? criterion.scorers : []
    );
    return [
      {
        name: criterion.name,
        scorers: args.scorers.filter((scorer) => {
          return isPlainObject(scorer) && bound.has(scorerOutcomeKey(scorer));
        }),
        probes: probesOf(criterion.probes),
      },
    ];
  });
};

const runProbe = async (args: {
  criterion: CriterionProbes;
  probe: Probe;
  index: number;
  agentOutputSchema: unknown;
  runners: ProbeRunners;
}): Promise<ProbeResult> => {
  const { criterion, probe } = args;
  const base = {
    criterion: criterion.name,
    index: args.index,
    expected: probe.passed,
  };
  try {
    const scores = await scoreOutput({
      scorers: criterion.scorers,
      input: probe.input,
      output: { content: probe.output },
      expectedOutput: probe.expectedOutput,
      itemMetadata: null,
      agentOutputSchema: args.agentOutputSchema,
      ...args.runners,
    });
    const passed = scores.every((outcome) => {
      return outcome.passed;
    });
    return { ...base, passed, held: passed === probe.passed, scores };
  } catch (error) {
    return {
      ...base,
      passed: false,
      held: false,
      scores: [],
      error: scoringFailure(error),
    };
  }
};

/** Every criterion's probes, in order; the report passes when each holds. */
export const runProbes = async (args: {
  criteria: unknown;
  scorers: unknown[];
  agentOutputSchema: unknown;
  runners: ProbeRunners;
}): Promise<ProbeReport> => {
  const probes: ProbeResult[] = [];
  for (const criterion of criterionProbes(args)) {
    for (const [index, probe] of criterion.probes.entries()) {
      probes.push(
        await runProbe({
          criterion,
          probe,
          index,
          agentOutputSchema: args.agentOutputSchema,
          runners: args.runners,
        })
      );
    }
  }
  const passed = probes.every((probe) => {
    return probe.held;
  });
  log('runProbes: probes=%d passed=%s', probes.length, passed);
  return { passed, probes };
};

/** The probes that did not hold, as a refusal names them. */
export const failedProbes = (report: ProbeReport) => {
  return report.probes
    .filter((probe) => {
      return !probe.held;
    })
    .map(({ criterion, index, expected, passed, error }) => {
      return { criterion, index, expected, passed, ...(error && { error }) };
    });
};
