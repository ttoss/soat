import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { isSystemPath, normalizePath } from './filePaths';
import { compileJsonSchema, describeSchemaErrors } from './jsonSchemaValidator';
import { paginatedList } from './pagination';
import { isPlainObject } from './plainObject';
import { registerResourceFieldMap } from './policyCompiler';
import { makeResourceAccessor } from './resourceAccessor';
import { isUniqueViolation } from './uniqueViolation';

const log = createDebug('soat:metadataSchemas');

/**
 * What a project says a resource's `metadata` must satisfy.
 *
 * A corpus many writers share is only readable as structured data if the
 * structure is stated somewhere all of them see. A declaration is that
 * statement, and it is a row rather than an item in a list on the project: two
 * operators governing different corners write independently, where a single
 * column would make every change a whole-list replace and the second writer
 * would silently drop the first one's rule.
 *
 * Every declaration names its `resource_type` and the selector that type is
 * addressed by — a path prefix for a document, since a path is what a document
 * is filed under. A type joins {@link METADATA_SCHEMA_RESOURCE_TYPES} in the
 * change that gives it a gate, so a declaration always has a door that reads
 * it: one that governs nothing is worse than none, because its author believes
 * a rule is in force.
 *
 * The schema governs the bag, not whether one exists — a document with no
 * metadata is not refused, because `POST /documents/ingest` files one before
 * anybody can attach any, and a prefix nothing could be filed under would be a
 * worse guarantee than none.
 */

registerResourceFieldMap({
  resourceType: 'metadata_schema',
  publicIdColumn: { column: 'publicId' },
});

/** The resource types the registry can enforce. */
export const METADATA_SCHEMA_RESOURCE_TYPES = ['document'] as const;

export type MetadataSchemaResourceType =
  (typeof METADATA_SCHEMA_RESOURCE_TYPES)[number];

/** The wire field each type's selector is written in. */
const SELECTOR_FIELD: Record<MetadataSchemaResourceType, string> = {
  document: 'path_prefix',
};

type MetadataSchemaRow = InstanceType<typeof db.MetadataSchema> & {
  project?: InstanceType<typeof db.Project>;
};

const metadataSchemaIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const metadataSchemas = makeResourceAccessor<MetadataSchemaRow>({
  model: () => {
    return db.MetadataSchema;
  },
  includes: metadataSchemaIncludes,
  label: 'Metadata schema',
});

const mapMetadataSchema = (row: MetadataSchemaRow) => {
  return {
    id: row.publicId,
    project_id: row.project?.publicId,
    resource_type: row.resourceType,
    // Each type's selector is reported in the field it was written in, so a
    // caller reads back the declaration it sent.
    path_prefix: row.selector,
    schema: row.schema,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedMetadataSchema = ReturnType<typeof mapMetadataSchema>;

const isResourceType = (
  value: unknown
): value is MetadataSchemaResourceType => {
  return (
    typeof value === 'string' &&
    (METADATA_SCHEMA_RESOURCE_TYPES as readonly string[]).includes(value)
  );
};

/** The declared type, refused when it names one no write path reads. */
const readResourceType = (value: unknown): MetadataSchemaResourceType => {
  if (!isResourceType(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `resource_type must be one of: ${METADATA_SCHEMA_RESOURCE_TYPES.join(', ')}.`
    );
  }
  return value;
};

/**
 * The selector a declaration states, normalized.
 *
 * One reader per resource type, so adding a type is a case here plus a gate at
 * its own write path — never a selector some other type has to learn to
 * ignore. A document's is a path prefix, normalized so `/reports/` and
 * `reports` are one declaration.
 */
const readSelector = (args: {
  resourceType: MetadataSchemaResourceType;
  pathPrefix?: unknown;
}): string => {
  const missing = (): never => {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A ${args.resourceType} metadata schema is selected by ${SELECTOR_FIELD[args.resourceType]}.`
    );
  };

  switch (args.resourceType) {
    case 'document': {
      if (
        typeof args.pathPrefix !== 'string' ||
        args.pathPrefix.trim() === ''
      ) {
        return missing();
      }
      let prefix: string;
      try {
        prefix = normalizePath(args.pathPrefix);
      } catch {
        // `normalizePath` throws on a traversal above root: a prefix that names
        // no location rather than one that matches nothing.
        return missing();
      }
      if (isSystemPath(prefix)) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `'${prefix}' cannot be governed: the reserved root holds documents the runtime writes, which carry no caller metadata.`
        );
      }
      return prefix;
    }
  }
};

/**
 * The schema a declaration carries.
 *
 * A schema ajv cannot compile is refused **here**, which is what keeps a broken
 * one out of the table: stored, it would be a rule that silently governs
 * nothing, and its author would never learn it does not.
 */
const readSchema = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'schema must be a JSON Schema object.'
    );
  }
  if (!compileJsonSchema(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'schema is not a valid JSON Schema.'
    );
  }
  return value;
};

/** The refusal a second declaration of one selector gets. */
const selectorTaken = (args: {
  resourceType: MetadataSchemaResourceType;
  selector: string;
}): DomainError => {
  return new DomainError(
    'NAME_CONFLICT',
    `A metadata schema already governs '${args.selector}' for ${args.resourceType}; one selector has one schema.`,
    { resource_type: args.resourceType, path_prefix: args.selector }
  );
};

export const createMetadataSchema = async (args: {
  projectId: number;
  resourceType: unknown;
  pathPrefix?: unknown;
  schema: unknown;
}): Promise<MappedMetadataSchema> => {
  const resourceType = readResourceType(args.resourceType);
  const selector = readSelector({ resourceType, pathPrefix: args.pathPrefix });
  const schema = readSchema(args.schema);

  log(
    'createMetadataSchema: projectId=%d resourceType=%s selector=%s',
    args.projectId,
    resourceType,
    selector
  );

  try {
    const row = await db.MetadataSchema.create({
      projectId: args.projectId,
      resourceType,
      selector,
      schema,
    });
    return mapMetadataSchema(await metadataSchemas.reload(row));
  } catch (error) {
    // The unique index is the arbiter, so two concurrent declarations of one
    // selector cannot both land.
    if (isUniqueViolation(error)) {
      throw selectorTaken({ resourceType, selector });
    }
    throw error;
  }
};

export const listMetadataSchemas = async (args: {
  projectIds?: number[];
  resourceType?: string;
  limit?: number;
  offset?: number;
}) => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;
  if (args.resourceType) where.resourceType = args.resourceType;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['createdAt', 'ASC']],
    query: ({ limit, offset, order }) => {
      return db.MetadataSchema.findAndCountAll({
        where,
        include: metadataSchemaIncludes(),
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: mapMetadataSchema,
  });
};

export const getMetadataSchema = async (args: {
  id: string;
  /** Absent for a caller that resolved the project before it got here. */
  projectIds?: number[];
}): Promise<MappedMetadataSchema> => {
  return mapMetadataSchema(
    await metadataSchemas.getByPublicId({
      id: args.id,
      projectIds: args.projectIds,
    })
  );
};

export const updateMetadataSchema = async (args: {
  id: string;
  projectIds?: number[];
  pathPrefix?: unknown;
  schema?: unknown;
}): Promise<MappedMetadataSchema> => {
  const row = await metadataSchemas.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });

  // The type decides the selector's spelling and which gate reads the row, so
  // it is fixed at creation: changing it would silently repoint the
  // declaration at a different door. Delete and declare again instead.
  const resourceType = readResourceType(row.resourceType);

  const updates: Record<string, unknown> = {};
  if (args.pathPrefix !== undefined) {
    updates.selector = readSelector({
      resourceType,
      pathPrefix: args.pathPrefix,
    });
  }
  if (args.schema !== undefined) updates.schema = readSchema(args.schema);

  try {
    await row.update(updates);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw selectorTaken({
        resourceType,
        selector: String(updates.selector),
      });
    }
    throw error;
  }

  return mapMetadataSchema(await metadataSchemas.reload(row));
};

export const deleteMetadataSchema = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<void> => {
  const row = await metadataSchemas.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });
  await row.destroy();
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
 * The declaration governing a document at a path: the longest declared prefix
 * that covers it.
 *
 * One schema, never the union of every prefix that matches. A nested prefix is
 * how an author says "this corner is different", and merging would make that
 * unsayable — the inner rule could only ever add to the outer one.
 */
const documentDeclarationFor = async (args: {
  projectId: number;
  path: string;
}): Promise<MetadataSchemaRow | null> => {
  const declarations = (await db.MetadataSchema.findAll({
    where: { projectId: args.projectId, resourceType: 'document' },
  })) as MetadataSchemaRow[];

  let winner: MetadataSchemaRow | null = null;
  for (const declared of declarations) {
    if (!covers({ prefix: declared.selector, path: args.path })) continue;
    if (!winner || declared.selector.length > winner.selector.length) {
      winner = declared;
    }
  }

  return winner;
};

/**
 * The project a dry run asks about: the one it names, or the only one the
 * caller's credential reaches. A caller that can read several and names none
 * is asking about no project in particular, which has no answer.
 */
const resolveCheckedProjectId = async (args: {
  projectPublicId?: string;
  projectIds?: number[];
}): Promise<number> => {
  if (args.projectPublicId) {
    const project = await db.Project.findOne({
      where: { publicId: args.projectPublicId },
      attributes: ['id'],
    });
    if (!project) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Project '${args.projectPublicId}' not found.`
      );
    }
    return project.id as number;
  }

  if (args.projectIds?.length === 1) return args.projectIds[0];

  throw new DomainError('VALIDATION_FAILED', 'project_id is required.');
};

/** What a judged write carries, and what a dry run asks about. */
type DocumentMetadataCheck = {
  projectId: number;
  path: string | null;
  /** `null` when the document carries no bag. */
  metadata: Record<string, unknown> | null;
};

/**
 * A violation, or `null` when nothing governs the pair or it satisfies what
 * does. The one verdict the dry run and every gate read; no bag is an empty one.
 */
const findViolation = async (
  args: DocumentMetadataCheck
): Promise<{ declaration: MetadataSchemaRow; detail: string } | null> => {
  // A document with no path is at no prefix, so no declaration reaches it.
  if (!args.path) return null;

  const declaration = await documentDeclarationFor({
    projectId: args.projectId,
    path: normalizePath(args.path),
  });
  if (!declaration) return null;

  const validate = compileJsonSchema(declaration.schema);
  /* istanbul ignore next -- a schema that does not compile is refused when it
     is declared, so a stored one always does. */
  if (!validate) {
    log(
      'findViolation: stored schema %s does not compile',
      declaration.publicId
    );
    return null;
  }

  if (validate(args.metadata ?? {})) return null;

  return { declaration, detail: describeSchemaErrors(validate.errors) };
};

/**
 * Answers what a write would be told, without writing.
 *
 * The one place a caller can ask "would this be accepted?" — the gates below
 * are what refuse, because a check a writer has to call itself is advisory and
 * the writer who skips it is the one the rule exists for.
 */
export const checkDocumentMetadata = async (args: {
  /** The project named by the request, when it named one. */
  projectPublicId?: string;
  /** The projects the caller may read, or `undefined` for every project. */
  projectIds?: number[];
  path: string | null;
  metadata: Record<string, unknown> | null;
}) => {
  const violation = await findViolation({
    projectId: await resolveCheckedProjectId(args),
    path: args.path,
    metadata: args.metadata,
  });

  return {
    valid: violation === null,
    resource_type: 'document',
    metadata_schema_id: violation?.declaration.publicId ?? null,
    path_prefix: violation?.declaration.selector ?? null,
    error: violation?.detail ?? null,
  };
};

const assertValid = async (args: DocumentMetadataCheck): Promise<void> => {
  const violation = await findViolation(args);
  if (!violation) return;

  throw new DomainError(
    'VALIDATION_FAILED',
    `metadata does not satisfy the schema declared for '${violation.declaration.selector}': ${violation.detail}`,
    {
      metadata_schema_id: violation.declaration.publicId,
      resource_type: 'document',
      path_prefix: violation.declaration.selector,
    }
  );
};

/** Judges a document create, which states its bag even by omitting it. */
export const assertCreatedDocumentMetadataValid = assertValid;

/**
 * Judges a document update against the pair it leaves behind.
 *
 * A move is judged too, because it changes which schema applies — a document
 * cannot be walked into a prefix its bag, or its lack of one, does not satisfy.
 * A write touching neither half is not re-judged: tightening a schema refuses
 * the next write of the fields it governs, and does not retroactively freeze
 * every document already stored.
 */
export const assertUpdatedDocumentMetadataValid = async (args: {
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
  if (args.metadata === undefined && args.path === undefined) return;

  return assertValid({
    projectId: args.projectId,
    path: args.path !== undefined ? args.path : args.currentPath,
    metadata:
      args.metadata !== undefined ? args.metadata : args.currentMetadata,
  });
};
