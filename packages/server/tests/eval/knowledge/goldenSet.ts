import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The versioned golden query set: the corpus to seed and the labeled query →
 * expected-result pairs to score against it.
 *
 * Expected results are **stable keys**, never ids: every seed regenerates the
 * public ids, so a labeled id would be stale before the first run finishes. A
 * key names a whole document or memory, so a hit is any chunk of the
 * expected document — chunk-level labels would be invalidated by any change to
 * `DEFAULT_CHUNK_SIZE` or `DEFAULT_CHUNK_OVERLAP`, neither of which is a
 * ranking change.
 */

export type GoldenSourceType = 'document' | 'memory';

export type GoldenQueryKind =
  'exact_token' | 'exact_name' | 'entity' | 'semantic' | 'freshness';

export const GOLDEN_QUERY_KINDS: GoldenQueryKind[] = [
  'entity',
  'exact_name',
  'exact_token',
  'freshness',
  'semantic',
];

/**
 * A corpus document: frozen text carried inline.
 *
 * Some fixtures are snapshots of module-doc prose, whose rare tokens recur
 * across files; the synthetic ones supply identifiers that occur exactly once
 * in the whole corpus, which is what an `exact_token` query needs to have a
 * single correct answer.
 *
 * The snapshots are committed, never re-read from the docs at seed time: a
 * pointer made the baseline a function of documentation prose as well as
 * ranking code, so any docs edit moved the numbers and any ranking PR that
 * documented itself could not read its own eval diff (#1345). Going stale
 * relative to the live docs costs nothing — the eval needs plausible prose to
 * rank against, not accurate documentation.
 */
export type GoldenDocument = {
  key: string;
  path: string;
  content: string;
};

export type GoldenMemory = {
  key: string;
  content: string;
  tags?: Record<string, string>;
  /**
   * How far in the past the seeder backdates this entry's `updated_at`,
   * relative to the run — never an absolute timestamp, so two runs a month
   * apart score the same ranking.
   *
   * Omitted means "written by this run", which is what every fixture was
   * before the recency blend existed: at age zero every decay factor is 1 and
   * the blend leaves the ranking exactly as it found it.
   */
  age_days?: number;
  /**
   * The memory store container to write this entry to, defaulting to the
   * corpus's single one.
   *
   * No fixture sets it. It used to hold the `freshness` twins apart, on the
   * premise that a near-twin could not survive beside its pair in one store —
   * measured false: five of the six sit at 0.77–0.90 cosine under the eval's
   * embedder, and the corpus store now declares its own band
   * (`CORPUS_SUPERSEDE_THRESHOLD`) so all six coexist. The split was not free:
   * a twin in a second store measures an unscoped search across a
   * current/archive pair, which `memory_store_ids` already answers, rather
   * than what the write path actually produces (#1333).
   *
   * Kept because a future fixture may need two containers on purpose, and
   * because `knowledgeGoldenFreshness.test.ts` asserts on its absence — which
   * is what stops the archive arrangement returning unnoticed.
   */
  memory_store?: string;
};

export type GoldenExpectation = {
  source_type: GoldenSourceType;
  key: string;
};

export type GoldenQuery = {
  id: string;
  query: string;
  kind: GoldenQueryKind;
  expected: GoldenExpectation[];
};

export type GoldenSet = {
  version: number;
  corpus: { documents: GoldenDocument[]; memories: GoldenMemory[] };
  queries: GoldenQuery[];
};

export const GOLDEN_SET_PATH = path.join(__dirname, 'golden.json');

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readString = (args: { value: unknown; field: string }): string => {
  if (typeof args.value !== 'string' || args.value.length === 0) {
    throw new Error(`golden.json: ${args.field} must be a non-empty string`);
  }
  return args.value;
};

const readOptionalString = (args: {
  value: unknown;
  field: string;
}): string | undefined => {
  if (args.value === undefined) return undefined;
  return readString(args);
};

const readTags = (args: {
  value: unknown;
  field: string;
}): Record<string, string> | undefined => {
  if (args.value === undefined) return undefined;
  if (!isRecord(args.value)) {
    throw new Error(`golden.json: ${args.field} must be an object`);
  }
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(args.value)) {
    tags[key] = readString({ value: tagValue, field: `${args.field}.${key}` });
  }
  return tags;
};

/** A non-negative, finite count — the one shape `age_days` may take. */
const readOptionalAge = (args: {
  value: unknown;
  field: string;
}): number | undefined => {
  if (args.value === undefined) return undefined;
  if (
    typeof args.value !== 'number' ||
    !Number.isFinite(args.value) ||
    args.value < 0
  ) {
    throw new Error(
      `golden.json: ${args.field} must be a non-negative finite number`
    );
  }
  return args.value;
};

const readArray = (args: { value: unknown; field: string }): unknown[] => {
  if (!Array.isArray(args.value)) {
    throw new Error(`golden.json: ${args.field} must be an array`);
  }
  return args.value;
};

const readDocument = (args: {
  value: unknown;
  field: string;
}): GoldenDocument => {
  if (!isRecord(args.value)) {
    throw new Error(`golden.json: ${args.field} must be an object`);
  }
  if (args.value.source !== undefined || args.value.section !== undefined) {
    throw new Error(
      `golden.json: ${args.field} must carry inline \`content\`; a \`source\` + \`section\` pointer into a module doc makes the baseline move with the docs (#1345)`
    );
  }
  return {
    key: readString({ value: args.value.key, field: `${args.field}.key` }),
    path: readString({ value: args.value.path, field: `${args.field}.path` }),
    content: readString({
      value: args.value.content,
      field: `${args.field}.content`,
    }),
  };
};

const readMemory = (args: { value: unknown; field: string }): GoldenMemory => {
  if (!isRecord(args.value)) {
    throw new Error(`golden.json: ${args.field} must be an object`);
  }
  return {
    key: readString({ value: args.value.key, field: `${args.field}.key` }),
    content: readString({
      value: args.value.content,
      field: `${args.field}.content`,
    }),
    tags: readTags({ value: args.value.tags, field: `${args.field}.tags` }),
    age_days: readOptionalAge({
      value: args.value.age_days,
      field: `${args.field}.age_days`,
    }),
    memory_store: readOptionalString({
      value: args.value.memory_store,
      field: `${args.field}.memory_store`,
    }),
  };
};

const readSourceType = (args: {
  value: unknown;
  field: string;
}): GoldenSourceType => {
  const raw = readString(args);
  if (raw !== 'document' && raw !== 'memory') {
    throw new Error(
      `golden.json: ${args.field} must be 'document' or 'memory', received '${raw}'`
    );
  }
  return raw;
};

const readKind = (args: { value: unknown; field: string }): GoldenQueryKind => {
  const raw = readString(args);
  const kind = GOLDEN_QUERY_KINDS.find((candidate) => {
    return candidate === raw;
  });
  if (kind === undefined) {
    throw new Error(
      `golden.json: ${args.field} must be one of ${GOLDEN_QUERY_KINDS.join(', ')}, received '${raw}'`
    );
  }
  return kind;
};

const readQuery = (args: { value: unknown; field: string }): GoldenQuery => {
  if (!isRecord(args.value)) {
    throw new Error(`golden.json: ${args.field} must be an object`);
  }
  const expected = readArray({
    value: args.value.expected,
    field: `${args.field}.expected`,
  }).map((entry, index) => {
    const field = `${args.field}.expected[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`golden.json: ${field} must be an object`);
    }
    return {
      source_type: readSourceType({
        value: entry.source_type,
        field: `${field}.source_type`,
      }),
      key: readString({ value: entry.key, field: `${field}.key` }),
    };
  });
  if (expected.length === 0) {
    throw new Error(
      `golden.json: ${args.field}.expected must name at least one key`
    );
  }
  return {
    id: readString({ value: args.value.id, field: `${args.field}.id` }),
    query: readString({
      value: args.value.query,
      field: `${args.field}.query`,
    }),
    kind: readKind({ value: args.value.kind, field: `${args.field}.kind` }),
    expected,
  };
};

const assertUnique = (args: { values: string[]; label: string }) => {
  const seen = new Set<string>();
  for (const value of args.values) {
    if (seen.has(value)) {
      throw new Error(`golden.json: duplicate ${args.label} '${value}'`);
    }
    seen.add(value);
  }
};

export const parseGoldenSet = (args: { raw: unknown }): GoldenSet => {
  if (!isRecord(args.raw)) {
    throw new Error('golden.json: the document must be an object');
  }
  if (typeof args.raw.version !== 'number') {
    throw new Error('golden.json: version must be a number');
  }
  if (!isRecord(args.raw.corpus)) {
    throw new Error('golden.json: corpus must be an object');
  }

  const documents = readArray({
    value: args.raw.corpus.documents,
    field: 'corpus.documents',
  }).map((value, index) => {
    return readDocument({ value, field: `corpus.documents[${index}]` });
  });

  const memories = readArray({
    value: args.raw.corpus.memories,
    field: 'corpus.memories',
  }).map((value, index) => {
    return readMemory({ value, field: `corpus.memories[${index}]` });
  });

  const queries = readArray({ value: args.raw.queries, field: 'queries' }).map(
    (value, index) => {
      return readQuery({ value, field: `queries[${index}]` });
    }
  );

  const documentKeys = documents.map((document) => {
    return document.key;
  });
  const memoryKeys = memories.map((memory) => {
    return memory.key;
  });

  assertUnique({
    values: [...documentKeys, ...memoryKeys],
    label: 'corpus key',
  });
  assertUnique({
    values: queries.map((query) => {
      return query.id;
    }),
    label: 'query id',
  });
  assertUnique({
    values: documents.map((document) => {
      return document.path;
    }),
    label: 'document path',
  });

  // A label naming a key no fixture seeds can never be retrieved, so it would
  // silently depress recall forever instead of failing loudly once.
  const knownDocuments = new Set(documentKeys);
  const knownMemories = new Set(memoryKeys);
  for (const query of queries) {
    for (const expectation of query.expected) {
      const known =
        expectation.source_type === 'document' ? knownDocuments : knownMemories;
      if (!known.has(expectation.key)) {
        throw new Error(
          `golden.json: query '${query.id}' expects ${expectation.source_type} '${expectation.key}', which the corpus does not seed`
        );
      }
    }
  }

  return {
    version: args.raw.version,
    corpus: { documents, memories },
    queries,
  };
};

export const loadGoldenSet = (): GoldenSet => {
  return parseGoldenSet({
    raw: JSON.parse(readFileSync(GOLDEN_SET_PATH, 'utf8')),
  });
};
