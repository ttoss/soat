import { defineMigration } from '@ttoss/postgresdb';

/**
 * Deciders move to the question and answer shapes of OpenAI's Decisions API,
 * and a decision may carry its own `questions` instead of naming a decider.
 *
 * - `decisions.decider_id` / `decider_version` nullable, `decisions.questions`
 *   added.
 * - Every stored question set — `deciders.questions` and each
 *   `decider_versions.config.questions` — from a map keyed by id to an array
 *   carrying `name`: `boolean` → `predicate` (its `criteria` appended to the
 *   instructions), choice `criteria` → `choices[{ value, description }]`, score
 *   `criteria` → `levels[{ label, description }]` with both set to the level.
 * - Every settled decision's `answers` from a map to an array in the order of
 *   the question set it was answered under: `boolean` → `predicate` with the
 *   probability of `true` (else 1 or 0), score `legend` dropped and
 *   `probabilities` maps to `[{ value, label?, probability }]`.
 *
 * Answers are converted first, reading each decision's archived question set
 * while it still holds the old shape. One statement string, so no set is ever
 * left half converted.
 */
const UP_SQL = `
  CREATE OR REPLACE FUNCTION pg_temp.soat_question(name text, q json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE q->>'type'
      WHEN 'boolean' THEN json_build_object(
        'type', 'predicate', 'name', name,
        'instructions', (q->>'instructions') || COALESCE(
          E'\\n\\nTrue: ' || (q->'criteria'->>'true') ||
          E'\\nFalse: ' || (q->'criteria'->>'false'), ''))
      WHEN 'choice' THEN json_build_object(
        'type', 'choice', 'name', name, 'instructions', q->>'instructions',
        'choices', (
          SELECT json_agg(json_build_object(
            'value', c.key, 'description', c.value #>> '{}') ORDER BY c.ord)
            FROM json_each(q->'criteria') WITH ORDINALITY AS c(key, value, ord)))
      ELSE json_build_object(
        'type', 'score', 'name', name, 'instructions', q->>'instructions',
        'levels', (
          SELECT json_agg(json_build_object(
            'label', l.value #>> '{}', 'description', l.value #>> '{}')
            ORDER BY l.ord)
            FROM json_array_elements(q->'criteria')
              WITH ORDINALITY AS l(value, ord)))
    END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_questions(q json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(q) = 'object' THEN (
      SELECT COALESCE(
        json_agg(pg_temp.soat_question(e.key, e.value) ORDER BY e.ord), '[]')
        FROM json_each(q) WITH ORDINALITY AS e(key, value, ord))
    ELSE q END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_answer(name text, a jsonb, q json) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE a->>'type'
      WHEN 'boolean' THEN jsonb_build_object(
        'type', 'predicate', 'name', name,
        'probability', COALESCE(
          (a->'probabilities'->'true'),
          CASE WHEN (a->>'value')::boolean THEN '1'::jsonb ELSE '0'::jsonb END))
      WHEN 'choice' THEN jsonb_strip_nulls(jsonb_build_object(
        'type', 'choice', 'name', name, 'choice', a->'choice',
        'probabilities', (
          SELECT jsonb_agg(jsonb_build_object(
            'value', p.key, 'probability', p.value))
            FROM jsonb_each(a->'probabilities') AS p)))
      ELSE jsonb_strip_nulls(jsonb_build_object(
        'type', 'score', 'name', name, 'score', a->'score',
        'probabilities', (
          SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'value', p.key::int,
            'label', q->'criteria'->>(p.key::int),
            'probability', p.value)) ORDER BY p.key::int)
            FROM jsonb_each(a->'probabilities') AS p)))
    END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_answers(a jsonb, q json) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN jsonb_typeof(a) = 'object' THEN (
      SELECT COALESCE(jsonb_agg(
        pg_temp.soat_answer(e.key, e.value, q->e.key)
        ORDER BY o.ord NULLS LAST, e.key), '[]')
        FROM jsonb_each(a) AS e(key, value)
        LEFT JOIN (
          SELECT k.key, k.ord FROM json_each(
            CASE WHEN json_typeof(q) = 'object' THEN q ELSE '{}'::json END
          ) WITH ORDINALITY AS k(key, value, ord)
        ) AS o ON o.key = e.key)
    ELSE a END
  $$;

  ALTER TABLE decisions
    ALTER COLUMN decider_id DROP NOT NULL,
    ALTER COLUMN decider_version DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS questions json;

  UPDATE decisions AS dn
     SET answers = pg_temp.soat_answers(dn.answers, (
       SELECT dv.config->'questions'
         FROM decider_versions AS dv
         JOIN deciders AS d ON d.id = dv.decider_id
        WHERE d.public_id = dn.decider_id
          AND dv.version = dn.decider_version))
   WHERE jsonb_typeof(dn.answers) = 'object';

  UPDATE decider_versions
     SET config = json_build_object(
       'questions', pg_temp.soat_questions(config->'questions'))
   WHERE json_typeof(config->'questions') = 'object';

  UPDATE deciders
     SET questions = pg_temp.soat_questions(questions)
   WHERE json_typeof(questions) = 'object';
`;

const PENDING_SQL = `
  SELECT 1 FROM deciders WHERE json_typeof(questions) = 'object'
  UNION ALL
  SELECT 1 FROM decider_versions
   WHERE json_typeof(config->'questions') = 'object'
  UNION ALL
  SELECT 1 FROM decisions WHERE jsonb_typeof(answers) = 'object'
  LIMIT 1
`;

export const decisionsOpenaiShape = defineMigration({
  name: '2026-10-07-decisions-openai-shape',
  description:
    'Decider questions and decision answers in the OpenAI Decisions API shape; decisions.questions for inline decisions.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'decisions' }))) return true;
    if (
      !(await context.columnExists({ table: 'decisions', column: 'questions' }))
    ) {
      return false;
    }
    return (await context.select({ sql: PENDING_SQL })).length === 0;
  },
  up: async (context) => {
    context.say(
      'converting decider questions and decision answers to the OpenAI Decisions shape'
    );
    await context.run({ sql: UP_SQL });
  },
});
