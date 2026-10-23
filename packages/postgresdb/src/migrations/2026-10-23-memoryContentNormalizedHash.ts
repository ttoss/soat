import { defineMigration } from '@ttoss/postgresdb';

import { hashMemoryContent } from '../utils/memoryContentHash';

type ContentRow = {
  id: number;
  memory_store_id: number;
  content: string;
  content_hash: string;
};

type Rehash = { id: number; hash: string; survivor: number };

/**
 * Every row whose hash changes or that merges into an older row. Rows sharing a
 * new hash in one store collapse onto the oldest, which keeps its vector: the
 * rest of the corpus was embedded by the same model.
 */
const planRehash = (rows: ContentRow[]): Rehash[] => {
  const survivors = new Map<string, number>();
  return rows.flatMap((row) => {
    const hash = hashMemoryContent({ content: row.content });
    const key = `${row.memory_store_id}:${hash}`;
    const survivor = survivors.get(key) ?? row.id;
    survivors.set(key, survivor);
    return hash === row.content_hash && survivor === row.id
      ? []
      : [{ id: row.id, hash, survivor }];
  });
};

const loadPlan = async (context: {
  select: <T>(args: { sql: string }) => Promise<T[]>;
}) => {
  const rows = await context.select<ContentRow>({
    sql: `SELECT id, memory_store_id, content, content_hash
            FROM memory_contents
           ORDER BY memory_store_id, created_at, id`,
  });
  return planRehash(rows);
};

/**
 * One statement string, so no store is left with memories pointing at a row
 * that is gone. Losers are deleted before survivors are rehashed: a survivor's
 * new hash can only equal the old hash of a row in its own group.
 */
const rehashSql = (plan: Rehash[]) => {
  // Integers and hex digests only, computed above: nothing caller-written.
  const values = plan
    .map((r) => {
      return `(${r.id}, '${r.hash}', ${r.survivor})`;
    })
    .join(',\n');

  return `
    CREATE TEMP TABLE soat_memory_content_rehash (
      id integer PRIMARY KEY, hash varchar(64) NOT NULL, survivor integer NOT NULL
    );
    INSERT INTO soat_memory_content_rehash VALUES ${values};

    UPDATE memory_contents AS s
       SET embedding = l.embedding
      FROM soat_memory_content_rehash AS r
      JOIN memory_contents AS l ON l.id = r.id
     WHERE r.survivor <> r.id AND s.id = r.survivor
       AND s.embedding IS NULL AND l.embedding IS NOT NULL;

    UPDATE memories AS m
       SET content_id = r.survivor
      FROM soat_memory_content_rehash AS r
     WHERE m.content_id = r.id AND r.survivor <> r.id;

    UPDATE memory_assertions AS a
       SET content_id = r.survivor
      FROM soat_memory_content_rehash AS r
     WHERE a.content_id = r.id AND r.survivor <> r.id;

    DELETE FROM memory_contents AS c
     USING soat_memory_content_rehash AS r
     WHERE c.id = r.id AND r.survivor <> r.id;

    UPDATE memory_contents AS c
       SET content_hash = r.hash
      FROM soat_memory_content_rehash AS r
     WHERE c.id = r.id AND r.survivor = r.id;

    DROP TABLE soat_memory_content_rehash;
  `;
};

export const memoryContentNormalizedHash = defineMigration({
  name: '2026-10-23-memory-content-normalized-hash',
  description:
    'memory_contents.content_hash recomputed over case- and punctuation-' +
    'insensitive text, and rows that now share a hash in one store merged.',
  // A missing table is not applied: an earlier migration may yet create it and
  // fill it with rows hashed the old way.
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'memory_contents' })))
      return false;
    return (await loadPlan(context)).length === 0;
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: 'memory_contents' }))) return;
    const plan = await loadPlan(context);
    context.say(`rehashing ${plan.length} memory content rows`);
    if (plan.length === 0) return;
    await context.run({ sql: rehashSql(plan) });
  },
});
