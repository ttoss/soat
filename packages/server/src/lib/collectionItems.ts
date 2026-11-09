import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { assertItemData, mergePatch, readItemKey } from './collectionItemData';
import type { CollectionRow } from './collections';
import { paginatedList } from './pagination';
import { registerResourceFieldMap } from './policyCompiler';
import { hasPolicyConstraints } from './policyWhere';
import { assertStorageQuota, jsonBytes } from './quotaStorage';
import {
  applyFilterWhere,
  compileStructuredWhere,
  type StructuredFilter,
} from './structuredFilter';
import { applyTagFilter, mergeTags } from './tags';
import { isUniqueViolation } from './uniqueViolation';
import { versionConflict } from './writePrecondition';

const log = createDebug('soat:collections');

// An item's SRN is `srn:<project>:collection_item:<key>`: a policy names items
// by key, and the collection check beside it confines the key to one
// collection.
registerResourceFieldMap({
  resourceType: 'collection_item',
  publicIdColumn: { column: 'key' },
  tagsColumn: { column: 'tags' },
});

type ItemRow = InstanceType<typeof db.CollectionItem>;

/** Statement timeout for an item listing, which may range over any field. */
const queryTimeoutMs = (): number => {
  const raw = Number(process.env.COLLECTION_QUERY_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 5000;
};

/** Postgres' `query_canceled`, raised when `statement_timeout` fires. */
const QUERY_CANCELED = '57014';

const isQueryCanceled = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    'parent' in error &&
    error.parent instanceof Error &&
    'code' in error.parent &&
    error.parent.code === QUERY_CANCELED
  );
};

const mapItem = (args: { row: ItemRow; collectionPublicId: string }) => {
  return {
    collection_id: args.collectionPublicId,
    key: args.row.key,
    data: args.row.data,
    tags: args.row.tags ?? undefined,
    version: args.row.version,
    created_at: args.row.createdAt,
    updated_at: args.row.updatedAt,
  };
};

export type MappedCollectionItem = ReturnType<typeof mapItem>;

const itemNotFound = (key: string): DomainError => {
  return new DomainError('RESOURCE_NOT_FOUND', `Item '${key}' not found.`);
};

const findRow = (args: { collection: CollectionRow; key: string }) => {
  return db.CollectionItem.findOne({
    where: { collectionId: args.collection.id, key: readItemKey(args.key) },
  });
};

/** The item, or `null` when the collection holds no item at `key`. */
export const findCollectionItem = async (args: {
  collection: CollectionRow;
  key: string;
}): Promise<MappedCollectionItem | null> => {
  const row = await findRow(args);
  if (!row) return null;
  return mapItem({ row, collectionPublicId: args.collection.publicId });
};

/**
 * Writes `fields` over the row at the version the caller named, or at the
 * version just read. One conditional `UPDATE` refuses a stale claim and a lost
 * race alike.
 */
const writeVersioned = async (args: {
  collection: CollectionRow;
  row: ItemRow;
  fields: {
    data?: Record<string, unknown>;
    tags?: Record<string, string> | null;
  };
  expectedVersion: number | null;
}): Promise<MappedCollectionItem> => {
  const [claimed] = await db.CollectionItem.update(
    { ...args.fields, version: args.row.version + 1 },
    {
      where: {
        id: args.row.id,
        version: args.expectedVersion ?? args.row.version,
      },
    }
  );
  await args.row.reload();
  if (claimed === 0) {
    throw versionConflict({
      currentVersion: args.row.version,
      expectedVersion: args.expectedVersion,
      resourceLabel: 'Item',
      resourceId: args.row.key,
    });
  }
  return mapItem({
    row: args.row,
    collectionPublicId: args.collection.publicId,
  });
};

const assertDataStorage = async (args: {
  collection: CollectionRow;
  data: Record<string, unknown>;
}): Promise<void> => {
  await assertStorageQuota({
    projectId: args.collection.projectId,
    addedBytes: jsonBytes(args.data),
  });
};

/**
 * Creates the item at `key`, or replaces its `data`. `tags` replace the bag
 * when given and leave it alone when `undefined`.
 */
export const putCollectionItem = async (args: {
  collection: CollectionRow;
  key: string;
  data: unknown;
  tags?: Record<string, string> | null;
  expectedVersion: number | null;
}): Promise<{ item: MappedCollectionItem; created: boolean }> => {
  log(
    'putCollectionItem: collection=%s key=%s',
    args.collection.publicId,
    args.key
  );
  const key = readItemKey(args.key);
  const data = assertItemData({
    data: args.data,
    schema: args.collection.schema,
  });
  await assertDataStorage({ collection: args.collection, data });

  const existing = await findRow({ collection: args.collection, key });
  if (existing) {
    return {
      item: await writeVersioned({
        collection: args.collection,
        row: existing,
        fields: { data, ...(args.tags !== undefined && { tags: args.tags }) },
        expectedVersion: args.expectedVersion,
      }),
      created: false,
    };
  }

  // A precondition names a version of an item that exists; none does.
  if (args.expectedVersion !== null) throw itemNotFound(key);

  try {
    const row = await db.CollectionItem.create({
      collectionId: args.collection.id,
      key,
      data,
      tags: args.tags ?? null,
    });
    return {
      item: mapItem({ row, collectionPublicId: args.collection.publicId }),
      created: true,
    };
  } catch (error) {
    // A concurrent writer created the key first; this write lost the race.
    if (!isUniqueViolation(error)) throw error;
    const winner = await findRow({ collection: args.collection, key });
    throw versionConflict({
      currentVersion: winner?.version ?? 1,
      expectedVersion: null,
      resourceLabel: 'Item',
      resourceId: key,
    });
  }
};

/** Merges `data` into the item's (RFC 7386); `tags` as in a put. */
export const patchCollectionItem = async (args: {
  collection: CollectionRow;
  key: string;
  data?: unknown;
  tags?: Record<string, string> | null;
  expectedVersion: number | null;
}): Promise<MappedCollectionItem> => {
  log(
    'patchCollectionItem: collection=%s key=%s',
    args.collection.publicId,
    args.key
  );
  const row = await findRow(args);
  if (!row) throw itemNotFound(args.key);

  const fields: {
    data?: Record<string, unknown>;
    tags?: Record<string, string> | null;
  } = {};
  if (args.data !== undefined) {
    fields.data = assertItemData({
      data: mergePatch({ target: row.data, patch: args.data }),
      schema: args.collection.schema,
    });
    await assertDataStorage({ collection: args.collection, data: fields.data });
  }
  if (args.tags !== undefined) fields.tags = args.tags;

  return writeVersioned({
    collection: args.collection,
    row,
    fields,
    expectedVersion: args.expectedVersion,
  });
};

export const deleteCollectionItem = async (args: {
  collection: CollectionRow;
  key: string;
}): Promise<void> => {
  log(
    'deleteCollectionItem: collection=%s key=%s',
    args.collection.publicId,
    args.key
  );
  const row = await findRow(args);
  if (!row) throw itemNotFound(args.key);
  await row.destroy();
};

/** The tag routes' contract is the bag itself; the write bumps the version. */
export const updateCollectionItemTags = async (args: {
  collection: CollectionRow;
  key: string;
  tags: Record<string, string>;
  merge?: boolean;
}): Promise<Record<string, string>> => {
  const row = await findRow(args);
  if (!row) throw itemNotFound(args.key);
  const tags = mergeTags({
    current: row.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  const item = await writeVersioned({
    collection: args.collection,
    row,
    fields: { tags },
    expectedVersion: null,
  });
  return item.tags ?? {};
};

export const listCollectionItems = async (args: {
  collection: CollectionRow;
  data?: StructuredFilter;
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}) => {
  log(
    'listCollectionItems: collection=%s data=%o',
    args.collection.publicId,
    args.data
  );
  const where: Record<string, unknown> = { collectionId: args.collection.id };
  applyTagFilter({ where, tags: args.tags });
  applyFilterWhere({
    where,
    fragments: compileStructuredWhere({
      filter: args.data,
      attribute: 'data',
      column: '"CollectionItem"."data"',
    }),
  });
  if (hasPolicyConstraints(args.policyWhere)) {
    applyFilterWhere({ where, fragments: [args.policyWhere] });
  }

  try {
    return await db.sequelize.transaction(async (transaction) => {
      await db.sequelize.query(
        `SET LOCAL statement_timeout = ${queryTimeoutMs()}`,
        { transaction }
      );
      return paginatedList({
        limit: args.limit,
        cursor: args.cursor,
        filters: {
          collection: args.collection.publicId,
          data: args.data,
          tags: args.tags,
        },
        where,
        order: [['key', 'ASC']],
        tiebreak: [],
        query: ({ where: pageWhere, limit, order }) => {
          return db.CollectionItem.findAll({
            where: pageWhere,
            order,
            limit,
            transaction,
          });
        },
        map: (row) => {
          return mapItem({ row, collectionPublicId: args.collection.publicId });
        },
      });
    });
  } catch (error) {
    if (!isQueryCanceled(error)) throw error;
    throw new DomainError(
      'QUERY_TIMEOUT',
      `The item query ran past ${queryTimeoutMs()} ms. Narrow it with an equality or \`in\` filter, which the index answers.`,
      { timeout_ms: queryTimeoutMs() }
    );
  }
};
