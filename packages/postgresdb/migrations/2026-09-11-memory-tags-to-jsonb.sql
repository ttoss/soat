-- Memory tags: text[] -> jsonb (key-value), aligning them with every other
-- tagged resource (actors, conversations, documents, files, sessions).
--
-- `sync --alter` CANNOT perform this change: Postgres refuses to cast text[]
-- to jsonb automatically, and a USING expression may not contain the subquery
-- the per-row conversion needs. Run this by hand, before deploying the release
-- that carries the new models.
--
-- Conversion, applied per element of the old array:
--   'role:manager'        -> {"role": "manager"}   (split on the FIRST colon,
--                                                   so values keep their own)
--   'customer'            -> {"customer": ""}      (a bare label has no value)
--   duplicate keys        -> last element wins
--   NULL stays NULL; an empty array becomes {}
--
-- A GLOB pattern that was only ever a search argument (e.g. 'customer*') has
-- no key-value equivalent. Stored tags are literals, so they convert cleanly;
-- it is the SEARCH side that needs a human: any saved `memory_tags` filter,
-- including an agent's `knowledge_config`, must be rewritten as exact pairs.
-- See the release notes for `knowledge_config.memory_tags` -> `tags`.

BEGIN;

ALTER TABLE memories ADD COLUMN tags_jsonb jsonb;

UPDATE memories SET tags_jsonb = (
  SELECT COALESCE(
    jsonb_object_agg(
      split_part(tag, ':', 1),
      CASE
        WHEN position(':' in tag) > 0
          THEN substring(tag from position(':' in tag) + 1)
        ELSE ''
      END
    ),
    '{}'::jsonb
  )
  FROM unnest(memories.tags) AS tag
)
WHERE memories.tags IS NOT NULL;

ALTER TABLE memories DROP COLUMN tags;
ALTER TABLE memories RENAME COLUMN tags_jsonb TO tags;

ALTER TABLE memory_entries ADD COLUMN tags_jsonb jsonb;

UPDATE memory_entries SET tags_jsonb = (
  SELECT COALESCE(
    jsonb_object_agg(
      split_part(tag, ':', 1),
      CASE
        WHEN position(':' in tag) > 0
          THEN substring(tag from position(':' in tag) + 1)
        ELSE ''
      END
    ),
    '{}'::jsonb
  )
  FROM unnest(memory_entries.tags) AS tag
)
WHERE memory_entries.tags IS NOT NULL;

ALTER TABLE memory_entries DROP COLUMN tags;
ALTER TABLE memory_entries RENAME COLUMN tags_jsonb TO tags;

COMMIT;
