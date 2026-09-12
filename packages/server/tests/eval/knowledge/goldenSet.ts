import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The versioned golden query set: the corpus to seed and the labeled query →
 * expected-result pairs to score against it.
 *
 * Expected results are **stable keys**, never ids: every seed regenerates the
 * public ids, so a labeled id would be stale before the first run finishes. A
 * key names a whole document or memory entry, so a hit is any chunk of the
 * expected document — chunk-level labels would be invalidated by any change to
 * `DEFAULT_CHUNK_SIZE` or `DEFAULT_CHUNK_OVERLAP`, neither of which is a
 * ranking change.
 */

export type GoldenSourceType = 'document' | 'memory';

export type GoldenQueryKind =
  'exact_token' | 'exact_name' | 'entity' | 'semantic';

export const GOLDEN_QUERY_KINDS: GoldenQueryKind[] = [
  'entity',
  'exact_name',
  'exact_token',
  'semantic',
];

/**
 * A corpus document: either a section lifted out of a module doc (`source` +
 * `section`) or synthetic text carried inline (`content`).
 *
 * The module docs supply real prose whose rare tokens recur across files;
 * the synthetic documents supply identifiers that occur exactly once in the
 * whole corpus, which is what an `exact_token` query needs to have a single
 * correct answer.
 */
export type GoldenDocument = {
  key: string;
  path: string;
  source?: string;
  section?: string;
  content?: string;
};

export type GoldenMemory = {
  key: string;
  content: string;
  tags?: Record<string, string>;
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

/** The repository root, four levels above `tests/eval/knowledge`. */
const repositoryRoot = (): string => {
  return path.resolve(__dirname, '../../../../..');
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
  const document: GoldenDocument = {
    key: readString({ value: args.value.key, field: `${args.field}.key` }),
    path: readString({ value: args.value.path, field: `${args.field}.path` }),
    source: readOptionalString({
      value: args.value.source,
      field: `${args.field}.source`,
    }),
    section: readOptionalString({
      value: args.value.section,
      field: `${args.field}.section`,
    }),
    content: readOptionalString({
      value: args.value.content,
      field: `${args.field}.content`,
    }),
  };
  const hasSection = document.source !== undefined;
  if (hasSection === (document.content !== undefined)) {
    throw new Error(
      `golden.json: ${args.field} must carry either \`source\` + \`section\` or inline \`content\`, not both and not neither`
    );
  }
  if (hasSection && document.section === undefined) {
    throw new Error(
      `golden.json: ${args.field}.section is required with \`source\``
    );
  }
  return document;
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

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Lifts one section out of a module doc: its heading line plus every line up to
 * the next heading at the same or a higher level.
 *
 * The heading must match exactly once. An ambiguous or renamed section is a
 * corpus error the eval must report on the spot, not a silently empty document
 * that drags recall down for a reason nobody can see.
 */
export const readDocumentSection = (args: {
  source: string;
  section: string;
}): string => {
  const absolute = path.join(repositoryRoot(), args.source);
  const lines = readFileSync(absolute, 'utf8').split('\n');

  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    const heading = HEADING.exec(line);
    if (heading && heading[2] === args.section) matches.push(index);
  }

  if (matches.length !== 1) {
    throw new Error(
      `golden.json: '${args.section}' matches ${matches.length} headings in ${args.source}; expected exactly one`
    );
  }

  const start = matches[0];
  const level = HEADING.exec(lines[start])![1].length;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = HEADING.exec(lines[index]);
    if (heading && heading[1].length <= level) {
      end = index;
      break;
    }
  }

  return `${lines.slice(start, end).join('\n').trimEnd()}\n`;
};

export const resolveDocumentContent = (args: {
  document: GoldenDocument;
}): string => {
  if (args.document.content !== undefined) return args.document.content;
  return readDocumentSection({
    source: args.document.source!,
    section: args.document.section!,
  });
};
