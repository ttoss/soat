/**
 * Every expand whose contract has not merged (`.claude/rules/postgresdb.md`).
 * `tests/harness/pendingContractions.test.mjs` fails when an entry outlives the
 * release after its expand, or disagrees with the code's markers.
 */
export type PendingContraction = {
  /** The expand migration's `name`. */
  expand: string;
  /** The column, table or value form the contract removes. */
  oldShape: string;
  /** Every file outside `src/migrations/` carrying this expand's marker. */
  shims: string[];
};

export const PENDING_CONTRACTIONS: PendingContraction[] = [
  {
    expand: '2026-11-21-eval-run-verdict',
    oldShape: 'eval_runs.passed',
    shims: [],
  },
];
