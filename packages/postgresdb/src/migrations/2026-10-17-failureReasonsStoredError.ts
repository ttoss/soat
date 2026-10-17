import { defineMigration } from '@ttoss/postgresdb';

/**
 * Every recorded failure reason is one object, `{ code, message, meta? }`, so
 * a reader can take `error.code` without first checking the type of `error`.
 *
 * - `documents.failure_reason` (a code, or a thrown error's message) becomes
 *   the jsonb `documents.error`.
 * - `eval_results.error` (free text) becomes jsonb.
 * - A formation operation's failed `events[].error` (a message) becomes the
 *   object: a create or update failure takes the operation's own code when
 *   the operation's error names that resource, a delete or rollback
 *   `FORMATION_DELETE_FAILED`, a replacement's cleanup
 *   `FORMATION_REPLACE_CLEANUP_FAILED`.
 * - A `generations.error` / `traces.error` with no `code` (a thrown error's
 *   `{ message, name }`) gains `GENERATION_FAILED`.
 *
 * A text value that is a code keeps it; free text keeps its words as the
 * message under the code its writer records for it. One statement string, so
 * no table is left half converted.
 */
const DOCUMENTS_SQL = `
  ALTER TABLE documents ADD COLUMN error jsonb;

  UPDATE documents SET error = CASE
    WHEN failure_reason = 'FILE_NOT_FOUND' THEN jsonb_build_object(
      'code', failure_reason,
      'message', 'The file to ingest no longer exists.')
    WHEN failure_reason = 'FILE_PARSE_FAILED' THEN jsonb_build_object(
      'code', failure_reason,
      'message', 'The file contains no extractable text.')
    WHEN failure_reason = 'INGESTION_TIMEOUT' THEN jsonb_build_object(
      'code', failure_reason,
      'message', 'The ingestion made no progress within the stall window.')
    WHEN failure_reason = 'CONVERSION_TIMEOUT' THEN jsonb_build_object(
      'code', failure_reason,
      'message', 'The converter did not call back within the stall window.')
    WHEN failure_reason = 'INGESTION_FAILED' THEN jsonb_build_object(
      'code', failure_reason,
      'message', 'The ingestion failed.')
    WHEN failure_reason ~ '^[A-Z][A-Z0-9_]*$' THEN jsonb_build_object(
      'code', failure_reason,
      'message', 'The ingestion failed with ' || failure_reason || '.')
    ELSE jsonb_build_object('code', 'INGESTION_FAILED', 'message', failure_reason)
  END
  WHERE failure_reason IS NOT NULL;

  ALTER TABLE documents DROP COLUMN failure_reason;
`;

const EVAL_RESULTS_SQL = `
  ALTER TABLE eval_results ALTER COLUMN error TYPE jsonb USING CASE
    WHEN error IS NULL THEN NULL
    WHEN error LIKE 'Generation did not complete%' THEN jsonb_build_object(
      'code', 'GENERATION_NOT_COMPLETED', 'message', error)
    WHEN error LIKE 'Scoring failed:%' THEN jsonb_build_object(
      'code', 'EVAL_SCORING_FAILED', 'message', error)
    ELSE jsonb_build_object('code', 'GENERATION_FAILED', 'message', error)
  END;
`;

const FORMATION_EVENTS_SQL = `
  UPDATE formation_operations SET events = (
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(e.value->'error') = 'string'
        THEN jsonb_set(e.value, '{error}', jsonb_build_object(
          'code', CASE
            WHEN e.value->>'error' = 'Internal Server Error'
              THEN 'INTERNAL_ERROR'
            WHEN e.value->>'action' IN ('delete', 'rollback')
              THEN 'FORMATION_DELETE_FAILED'
            WHEN e.value->>'action' = 'replace-cleanup'
              THEN 'FORMATION_REPLACE_CLEANUP_FAILED'
            WHEN formation_operations.error->'meta'->>'logical_id'
                = e.value->>'logicalId'
              THEN COALESCE(formation_operations.error->>'code', 'INTERNAL_ERROR')
            ELSE 'INTERNAL_ERROR'
          END,
          'message', e.value->>'error'))
        ELSE e.value
      END ORDER BY e.ord)
    FROM jsonb_array_elements(events) WITH ORDINALITY AS e(value, ord))
  WHERE jsonb_typeof(events) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(events) AS f(value)
      WHERE jsonb_typeof(f.value->'error') = 'string');
`;

const codelessErrorSql = (table: string): string => {
  return `
  UPDATE ${table} SET error = jsonb_build_object(
    'code', 'GENERATION_FAILED',
    'message', COALESCE(NULLIF(error->>'message', ''), 'The generation failed.'))
  WHERE jsonb_typeof(error) = 'object' AND error->'code' IS NULL;
`;
};

export const failureReasonsStoredError = defineMigration({
  name: '2026-10-17-failure-reasons-stored-error',
  description:
    'documents.failure_reason, eval_results.error and formation event errors to the { code, message, meta? } object, and a code on every generation and trace error.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'documents' }))) return true;
    return !(await context.columnExists({
      table: 'documents',
      column: 'failure_reason',
    }));
  },
  up: async (context) => {
    context.say('converting recorded failure reasons to { code, message }');
    const steps = [DOCUMENTS_SQL];
    if (await context.tableExists({ table: 'eval_results' })) {
      steps.push(EVAL_RESULTS_SQL);
    }
    if (await context.tableExists({ table: 'formation_operations' })) {
      steps.push(FORMATION_EVENTS_SQL);
    }
    for (const table of ['generations', 'traces']) {
      if (await context.tableExists({ table })) {
        steps.push(codelessErrorSql(table));
      }
    }
    await context.run({ sql: steps.join('\n') });
  },
});
