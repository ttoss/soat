/**
 * The words every record that runs or settles — a run, an attempt, a delivery,
 * an operation — answers with, from `queued` through one terminal state. A
 * module adds only its own non-terminal pauses (`requires_action`,
 * `awaiting_input`, `sleeping`, …) beside them, never a synonym for one of
 * these. `tests/unit/tests/lib/statusVocabularyContract.test.ts` holds every
 * `status` enum in the specs to it.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
