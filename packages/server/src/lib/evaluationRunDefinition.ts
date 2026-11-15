/**
 * What a run is graded by: its Eval's `scorers`, `pass_threshold` and
 * `group_by`, copied onto the run when it is created (the evaluations module
 * doc — Version pinning). Every item and the settle read this copy, so an edit
 * to the Eval reaches only runs created after it.
 */
import { scorerList } from './evaluationScorerValidation';
import { isPlainObject } from './plainObject';

export type EvalRunDefinition = {
  scorers: unknown[];
  passThreshold: number | null;
  groupBy: string | null;
};

/** The definition a run created now records, from its Eval's current row. */
export const evalRunDefinitionOf = (args: {
  evaluation: {
    scorers: unknown;
    passThreshold: string | null;
    groupBy: string | null;
  };
}): EvalRunDefinition => {
  const { scorers, passThreshold, groupBy } = args.evaluation;
  return {
    scorers: scorerList(scorers),
    passThreshold: passThreshold === null ? null : Number(passThreshold),
    groupBy,
  };
};

/** The stored (and wire) form: `EvalRun.definition`. */
export const storedEvalRunDefinition = (args: {
  definition: EvalRunDefinition;
}): Record<string, unknown> => {
  return {
    scorers: args.definition.scorers,
    pass_threshold: args.definition.passThreshold,
    group_by: args.definition.groupBy,
  };
};

/**
 * The definition a run recorded, or null when it recorded none: such a run
 * cannot be scored or settled.
 */
export const readEvalRunDefinition = (args: {
  run: { definition: Record<string, unknown> | null };
}): EvalRunDefinition | null => {
  const stored = args.run.definition;
  if (!isPlainObject(stored) || !Array.isArray(stored.scorers)) return null;

  return {
    scorers: stored.scorers,
    passThreshold:
      typeof stored.pass_threshold === 'number' ? stored.pass_threshold : null,
    groupBy: typeof stored.group_by === 'string' ? stored.group_by : null,
  };
};
