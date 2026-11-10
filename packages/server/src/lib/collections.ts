import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { compileJsonSchema } from './jsonSchemaValidator';
import { paginatedList } from './pagination';
import { isPlainObject } from './plainObject';
import { registerResourceFieldMap } from './policyCompiler';
import { projectScopeWhere } from './projectScope';
import { makeResourceAccessor } from './resourceAccessor';
import { isUniqueViolation } from './uniqueViolation';

const log = createDebug('soat:collections');

registerResourceFieldMap({
  resourceType: 'collection',
  publicIdColumn: { column: 'publicId' },
});

export type CollectionRow = InstanceType<typeof db.Collection> & {
  project?: InstanceType<typeof db.Project>;
};

const collectionIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const collections = makeResourceAccessor<CollectionRow>({
  model: () => {
    return db.Collection;
  },
  includes: collectionIncludes,
  label: 'Collection',
});

const mapCollection = (row: CollectionRow) => {
  return {
    id: row.publicId,
    project_id: row.project?.publicId,
    name: row.name,
    schema: row.schema ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export type MappedCollection = ReturnType<typeof mapCollection>;

const readName = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name must be a non-empty string.'
    );
  }
  return value;
};

/**
 * A schema ajv cannot compile is refused here, so every stored one validates:
 * stored, it would govern nothing while its author believed it did.
 */
const readSchema = (value: unknown): Record<string, unknown> | null => {
  if (value === null) return null;
  if (!isPlainObject(value) || !compileJsonSchema(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'schema is not a valid JSON Schema.'
    );
  }
  return value;
};

const nameTaken = (name: string): DomainError => {
  return new DomainError(
    'NAME_CONFLICT',
    `A collection named '${name}' already exists in this project.`,
    { name }
  );
};

const withNameConflict = async <T>(args: {
  name: string;
  write: () => Promise<T>;
}): Promise<T> => {
  try {
    return await args.write();
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(args.name);
    throw error;
  }
};

export const createCollection = async (args: {
  projectId: number;
  name: unknown;
  schema?: unknown;
}): Promise<MappedCollection> => {
  const name = readName(args.name);
  const schema = args.schema === undefined ? null : readSchema(args.schema);
  log('createCollection: projectId=%d name=%s', args.projectId, name);

  const row = await withNameConflict({
    name,
    write: () => {
      return db.Collection.create({ projectId: args.projectId, name, schema });
    },
  });
  return mapCollection(await collections.reload(row));
};

export const listCollections = async (args: {
  projectIds?: number[];
  limit?: number;
  cursor?: string;
}) => {
  const where: Record<string, unknown> = {};
  Object.assign(where, projectScopeWhere({ projectIds: args.projectIds }));

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds },
    where,
    order: [['createdAt', 'ASC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Collection.findAll({
        where: pageWhere,
        include: collectionIncludes(),
        order,
        limit,
      });
    },
    map: mapCollection,
  });
};

export const getCollection = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<MappedCollection> => {
  return mapCollection(await collections.getByPublicId(args));
};

export const updateCollection = async (args: {
  id: string;
  projectIds?: number[];
  name?: unknown;
  schema?: unknown;
}): Promise<MappedCollection> => {
  const row = await collections.getByPublicId(args);

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = readName(args.name);
  if (args.schema !== undefined) updates.schema = readSchema(args.schema);

  await withNameConflict({
    name: String(updates.name ?? row.name),
    write: () => {
      return row.update(updates);
    },
  });
  return mapCollection(await collections.reload(row));
};

export const deleteCollection = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<void> => {
  const row = await collections.getByPublicId(args);
  await row.destroy();
};
