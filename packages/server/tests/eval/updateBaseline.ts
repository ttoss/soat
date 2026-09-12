/**
 * Whether this run rewrites `baseline.json` instead of gating against it.
 *
 * Set by `runEval.mjs` from the `--update-baseline` flag. It travels as an
 * environment variable because Jest owns the command line — it rejects an
 * option it does not define — and because a worker's `process.argv` carries
 * none of the arguments the command was invoked with anyway.
 */
export const UPDATE_BASELINE_ENV = 'SOAT_EVAL_UPDATE_BASELINE';

export const shouldUpdateBaseline = (): boolean => {
  return process.env[UPDATE_BASELINE_ENV] === '1';
};
