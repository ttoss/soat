import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { isSystemPath, normalizePath } from './filePaths';
import { compileJsonSchema, describeSchemaErrors } from './jsonSchemaValidator';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:metadata-schemas');

/**
 * What a project says `metadata` must look like under a path prefix.
 *
 * A corpus many writers share is only readable as structured data if the
 * structure is stated somewhere both of them see. The project is that place:
 * one declaration, applied at every door a document's metadata is written
 * through, rather than each writer agreeing to a convention nothing checks.
 *
 * The schema governs the bag, not whether one exists — a document with no
 * metadata is not refused, because `POST /documents/ingest` files a document
 * before anybody can attach any, and a prefix no document could be created
 * under would be a worse guarantee than none.
 */

/** One declared rule, in the shape the column stores and the wire carries. */
type DeclaredSchema = {
  pathPrefix: string;
  schema: Record<string, unknown>;
};

const DECLARATION_SHAPE =
  'metadata_schemas must be a list of { path_prefix, schema } objects, or null to clear it.';

/** A declared prefix, normalized so `/reports/` and `reports` are one prefix. */
const readPrefix = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return normalizePath(value);
  } catch {
    // `normalizePath` throws on a traversal above root, which is a prefix that
    // names no location rather than one that matches nothing.
    return null;
  }
};

/**
 * Validates a project's declared list. Returns an error message, or `null` when
 * the list is valid. Pure, so the REST handler and any other write path judge a
 * declaration the same way.
 *
 * A schema ajv cannot compile is refused **here**, which is what keeps a broken
 * schema out of the column: stored, it would be a rule that silently governs
 * nothing, and the writer who declared it would never learn it does not.
 */
export const validateMetadataSchemas = (value: unknown): string | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) return DECLARATION_SHAPE;

  const seen = new Set<string>();

  for (const entry of value) {
    if (!isPlainObject(entry)) return DECLARATION_SHAPE;

    const prefix = readPrefix(entry.path_prefix);
    if (prefix === null) return DECLARATION_SHAPE;

    if (isSystemPath(prefix)) {
      return `metadata_schemas cannot govern '${prefix}': the reserved root holds documents the runtime writes, which carry no caller metadata.`;
    }

    if (seen.has(prefix)) {
      return `metadata_schemas declares '${prefix}' twice; one prefix has one schema.`;
    }
    seen.add(prefix);

    if (!isPlainObject(entry.schema)) return DECLARATION_SHAPE;
    if (!compileJsonSchema(entry.schema)) {
      return `metadata_schemas declares a schema for '${prefix}' that is not a valid JSON Schema.`;
    }
  }

  return null;
};

/** The stored list, read into the internal shape and skipping anything malformed. */
const readDeclarations = (value: unknown): DeclaredSchema[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return [];
    const pathPrefix = readPrefix(entry.path_prefix);
    if (pathPrefix === null || !isPlainObject(entry.schema)) return [];
    return [{ pathPrefix, schema: entry.schema }];
  });
};

/**
 * Whether a path is at or under a prefix. A boundary, never a substring, the
 * same rule `pathPrefixPattern` applies to a listing: `/reports` covers
 * `/reports/q1.txt` and never `/reports-archive/q1.txt`.
 */
const covers = (args: { prefix: string; path: string }): boolean => {
  if (args.prefix === '/') return true;
  return args.path === args.prefix || args.path.startsWith(`${args.prefix}/`);
};

/**
 * The schema governing a path: the longest declared prefix that covers it.
 *
 * One schema, never the union of every prefix that matches. A nested prefix is
 * how an author says "this corner is different", and merging would make that
 * unsayable — the inner rule could only ever add to the outer one.
 */
const schemaFor = (args: {
  declarations: DeclaredSchema[];
  path: string;
}): DeclaredSchema | null => {
  let winner: DeclaredSchema | null = null;

  for (const declared of args.declarations) {
    if (!covers({ prefix: declared.pathPrefix, path: args.path })) continue;
    if (!winner || declared.pathPrefix.length > winner.pathPrefix.length) {
      winner = declared;
    }
  }

  return winner;
};

/**
 * Refuses a document write whose metadata violates the schema in force for its
 * path.
 *
 * The project is read here rather than cached: the read is one primary key and
 * only happens for a write that states metadata, so the path that would make a
 * cache worth its staleness — a conversation turn, which files a document with
 * no metadata at all — never reaches it.
 */
const assertValid = async (args: {
  projectId: number;
  path: string | null;
  metadata: Record<string, unknown> | null;
}): Promise<void> => {
  // A document with no path is at no prefix, so no declaration reaches it.
  if (!args.path) return;

  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['metadataSchemas'],
  });
  const declared = schemaFor({
    declarations: readDeclarations(project?.metadataSchemas),
    path: normalizePath(args.path),
  });
  if (!declared) return;

  const validate = compileJsonSchema(declared.schema);
  /* istanbul ignore next -- a schema that does not compile is refused when it
     is declared, so a stored one always does. */
  if (!validate) {
    log(
      'assertValid: stored schema for %s does not compile',
      declared.pathPrefix
    );
    return;
  }

  if (validate(args.metadata ?? {})) return;

  throw new DomainError(
    'VALIDATION_FAILED',
    `metadata does not satisfy the schema declared for '${declared.pathPrefix}': ${describeSchemaErrors(validate.errors)}`,
    { path_prefix: declared.pathPrefix }
  );
};

/**
 * Judges a document create. Only a write that states metadata is judged: the
 * schema governs the bag, not whether the document carries one.
 */
export const assertCreatedMetadataValid = async (args: {
  projectId: number;
  path: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> => {
  if (args.metadata === undefined) return;
  return assertValid({ ...args, metadata: args.metadata });
};

/**
 * Judges a document update against the pair it leaves behind.
 *
 * A move is judged too, because it changes which schema applies — a document
 * carrying metadata cannot be walked into a prefix it does not satisfy. A write
 * touching neither half is not re-judged: tightening a schema refuses the next
 * write of the fields it governs, and does not retroactively freeze every
 * document already stored.
 */
export const assertUpdatedMetadataValid = async (args: {
  projectId: number;
  /** Where the document is filed now. */
  currentPath: string | null;
  /** The path the write states, or `undefined` when it states none. */
  path?: string | null;
  /** The metadata the write states, or `undefined` when it states none. */
  metadata?: Record<string, unknown> | null;
  /** What the document holds now. */
  currentMetadata: Record<string, unknown> | null;
}): Promise<void> => {
  const statesMetadata = args.metadata !== undefined;
  const moves = args.path !== undefined;

  if (!statesMetadata && !moves) return;

  const metadata =
    args.metadata !== undefined ? args.metadata : args.currentMetadata;
  // A move carries nothing to judge when the document holds no metadata.
  if (!statesMetadata && metadata === null) return;

  return assertValid({
    projectId: args.projectId,
    path: args.path !== undefined ? args.path : args.currentPath,
    metadata,
  });
};
