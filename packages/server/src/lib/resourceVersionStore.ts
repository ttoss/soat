import { isDeepStrictEqual } from 'node:util';

import type { Model, ModelCtor } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import type { ResourceIncludes } from './modelIncludes';
import type {
  ArchivedVersionRow,
  ConfigSnapshot,
  VersionedResourceRef,
} from './resourceVersions';
import { assertWritePrecondition, versionConflict } from './writePrecondition';

const log = createDebug('soat:versions');

/**
 * The resource-versioning engine's write side: the archive row, the version
 * counter it names, and the transaction that ties the two to the field write
 * that produced them.
 *
 * Separate from `resourceVersions.ts` — which owns the snapshot projection and
 * the read/restore endpoints — so `agents.ts` can commit a version without
 * importing `agentVersions.ts`, which imports `agents.ts` back.
 */

/** True when two snapshots describe the same configuration. */
const isSameConfig = (
  before: ConfigSnapshot,
  after: ConfigSnapshot
): boolean => {
  return isDeepStrictEqual(before, after);
};
// ── The store: writing and reading raw archive rows ───────────────────────

/**
 * Loaded with `createdBy` so a version response can name its author, plus
 * whatever associations the resource's own version table adds.
 */
const versionInclude = (extra?: () => ResourceIncludes): ResourceIncludes => {
  const base = [{ model: db.User, as: 'createdBy' }];

  // `ResourceIncludes` admits a single includeable as well as a list, so the
  // extras are normalized rather than spread blindly.
  const additional = extra?.();
  if (additional === undefined) return base;

  return [...base, ...(Array.isArray(additional) ? additional : [additional])];
};

type FindVersionRowArgs = {
  resource: VersionedResourceRef;
  version: number;
};

type WriteVersionArgs = {
  resourceDbId: number;
  version: number;
  config: ConfigSnapshot;
  label?: string | null;
  /** Required so a write path states its author; `null` is a platform write. */
  createdByUserId: number | null;
  transaction?: Transaction;
};

/**
 * A parent row the engine may lock, bump and read a version off. Every
 * versioned resource's model satisfies it; nothing else about the resource is
 * visible from here.
 */
export type VersionedResourceRow = Model & {
  version: number;
};

type CommitConfigChangeArgs = {
  /** The resource as the caller read it, which is the version being claimed. */
  resource: VersionedResourceRef;
  /** The version the caller states it is changing; absent states none. */
  expectedVersion?: number | null;
  before: ConfigSnapshot;
  /**
   * The resource's own field writes, run inside the commit's transaction.
   *
   * Returns the config they leave behind, and the instance the caller will map
   * its response from — the engine stamps the new version onto that instance,
   * so a write path that reloads after updating hands back the reloaded row
   * rather than the one it started with. Everything written here is rolled
   * back when the version claim below is lost.
   */
  applyWrite: (args: { transaction: Transaction }) => Promise<{
    row: VersionedResourceRow;
    after: ConfigSnapshot;
  }>;
  label?: string | null;
  /** Required so a write path states its author; `null` is a platform write. */
  createdByUserId: number | null;
};

type AssertWritableArgs = {
  resource: VersionedResourceRef;
  expectedVersion?: number | null;
};

type AssertVersionsExistArgs = {
  resource: VersionedResourceRef;
  versions: number[];
};

type DeleteVersionsArgs = {
  resourceDbId: number;
  transaction?: Transaction;
};

/**
 * The archive's write side, plus the raw reads that need no knowledge of the
 * parent resource beyond its row id.
 */
export type VersionStore = {
  /**
   * The precondition `commitConfigChange` checks first, for a write path that
   * changes state outside the row (a document's stored content and chunks)
   * before it commits: a refused write must not have touched anything.
   */
  assertWritable: (args: AssertWritableArgs) => void;
  assertVersionsExist: (args: AssertVersionsExistArgs) => Promise<void>;
  commitConfigChange: (args: CommitConfigChangeArgs) => Promise<void>;
  deleteVersions: (args: DeleteVersionsArgs) => Promise<void>;
  findVersionRow: (args: FindVersionRowArgs) => Promise<ArchivedVersionRow>;
  foreignKey: string;
  readArchivedConfig: (row: ArchivedVersionRow) => ConfigSnapshot;
  versionInclude: () => ResourceIncludes;
  versionModel: () => ModelCtor<ArchivedVersionRow>;
  writeVersion: (args: WriteVersionArgs) => Promise<void>;
};

type VersionTable = {
  /** Capitalized resource name used in error messages, e.g. `Agent`. */
  resourceLabel: string;
  /**
   * Resolves the version model. A thunk rather than the class itself because
   * `db` is assigned at boot, after this module is imported — capturing
   * `db.AgentVersion` eagerly would read `undefined`.
   */
  versionModel: () => ModelCtor<ArchivedVersionRow>;
  /**
   * Resolves the parent model, whose `version` column the commit claims. A
   * thunk for the same reason {@link VersionTable.versionModel} is one.
   */
  resourceModel: () => ModelCtor<VersionedResourceRow>;
  /** Column on the version table pointing at the parent, e.g. `agentId`. */
  foreignKey: string;
  /**
   * Associations this resource's version rows carry beyond `createdBy` — the
   * engine loads them but never reads them, so the resource's own mapper is
   * free to expose a field the archive itself has no concept of (an agent
   * version's `eval_run_id`, say). A thunk for the same reason
   * {@link VersionTable.versionModel} is one.
   */
  extraIncludes?: () => ResourceIncludes;
};

/** Row-level access to one version table: no policy, just queries. */
const makeVersionRows = (args: VersionTable) => {
  const { resourceLabel, versionModel, foreignKey } = args;
  const include = (): ResourceIncludes => {
    return versionInclude(args.extraIncludes);
  };

  /**
   * Narrows a stored `config` column to a snapshot. The column is NOT NULL and
   * only ever written from a snapshot projection, so a non-object here means the
   * row was edited outside the application.
   */
  const readArchivedConfig = (row: ArchivedVersionRow): ConfigSnapshot => {
    const config = row.config;
    /* istanbul ignore next -- unreachable through any write path; see above. */
    if (
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `${resourceLabel} '${row.publicId}' has an unreadable archived config.`
      );
    }
    return config as ConfigSnapshot;
  };

  const findVersionRow = async (
    a: FindVersionRowArgs
  ): Promise<ArchivedVersionRow> => {
    const row = await versionModel().findOne({
      where: { [foreignKey]: a.resource.dbId, version: a.version },
      include: include(),
    });

    if (!row) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `${resourceLabel} '${a.resource.publicId}' has no version ${a.version}.`
      );
    }
    return row;
  };

  /**
   * Rejects a set of version numbers unless every one exists. Used by the
   * release layer, which must never store a pointer to a version that was never
   * archived.
   */
  const assertVersionsExist = async (
    a: AssertVersionsExistArgs
  ): Promise<void> => {
    const rows = await versionModel().findAll({
      where: { [foreignKey]: a.resource.dbId, version: a.versions },
      attributes: ['version'],
    });

    const found = new Set(
      rows.map((row) => {
        return row.version;
      })
    );
    const missing = a.versions.filter((version) => {
      return !found.has(version);
    });

    if (missing.length > 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `${resourceLabel} '${a.resource.publicId}' has no version ${missing.join(', ')}.`,
        { missing }
      );
    }
  };

  /**
   * Removes every archived version of one resource. Archives are owned by their
   * parent, so this runs before the parent is destroyed and no orphan rows are
   * left behind.
   */
  const deleteVersions = async (a: DeleteVersionsArgs): Promise<void> => {
    await versionModel().destroy({
      where: { [foreignKey]: a.resourceDbId },
      transaction: a.transaction,
    });
  };

  return {
    assertVersionsExist,
    deleteVersions,
    findVersionRow,
    readArchivedConfig,
    versionInclude: include,
  };
};

/**
 * Builds the archive's write side for one version table.
 *
 * Nothing here mutates an existing version row. A restore appends a new version
 * rather than rewinding the counter, so audit references to the versions in
 * between never dangle and "undo the undo" is just another restore.
 */
/**
 * Archives one configuration. Called only from the resource's shared lib write
 * path, which is what makes a REST edit and a formation apply indistinguishable
 * here — both leave identical history.
 */
const makeWriteVersion = (args: VersionTable) => {
  const { resourceLabel, versionModel, foreignKey } = args;

  return async (a: WriteVersionArgs): Promise<void> => {
    log(
      'writeVersion: %s dbId=%d version=%d label=%s',
      resourceLabel,
      a.resourceDbId,
      a.version,
      a.label ?? null
    );

    await versionModel().create(
      {
        [foreignKey]: a.resourceDbId,
        version: a.version,
        config: a.config,
        label: a.label ?? null,
        createdByUserId: a.createdByUserId ?? null,
      },
      { transaction: a.transaction }
    );
  };
};

/**
 * Claims the transition from `expected` to `next` on the parent's counter.
 *
 * A conditional `UPDATE`, never a read-then-write: it is the point at which
 * two writers that read the same version are separated, and the loser has to
 * learn it lost from the statement itself rather than from a comparison made
 * against a value that may already be stale. `undefined` means another write
 * took this version first; otherwise the claimed row as the statement left it.
 */
const makeClaimVersion = (args: VersionTable) => {
  const { resourceModel } = args;

  return async (a: {
    resourceDbId: number;
    expected: number;
    next: number;
    transaction: Transaction;
  }): Promise<VersionedResourceRow | undefined> => {
    const [, claimed] = await resourceModel().update(
      { version: a.next },
      {
        where: { id: a.resourceDbId, version: a.expected },
        transaction: a.transaction,
        returning: true,
      }
    );
    return claimed[0];
  };
};

/**
 * Runs one config write and archives what it produced, as a single
 * transaction whose commit is conditional on the version nobody else having
 * moved.
 *
 * The three steps — the resource's field write, the version bump and the
 * archive row — are one transaction because they are one fact. A field write
 * that lands without its version, or a version without the config it names,
 * is a history that lies about what the resource held, and the reader who
 * finds out is a later run replaying a version that was never current.
 *
 * The ordering is what makes the claim meaningful. The row is locked and its
 * version re-read before `applyWrite`, so a second writer queues behind the
 * first and is refused before its write runs; the conditional claim then
 * separates any writer the lock did not. Nothing partial survives a conflict,
 * which is why the caller may answer `409` without having to undo anything —
 * provided every write it makes happens inside `applyWrite`.
 *
 * Change detection runs on the serialized config rather than on the incoming
 * fields, so a request that sets a field to the value it already held is a
 * no-op — including the whole-config replacement `restore` performs, which is
 * why restoring the live config is a genuine no-op instead of an endless
 * version chain. A no-op takes no version, so it cannot conflict either.
 */
const makeAssertWritable = (args: VersionTable) => {
  return (a: AssertWritableArgs): void => {
    assertWritePrecondition({
      expectedVersion: a.expectedVersion,
      currentVersion: a.resource.version,
      resourceLabel: args.resourceLabel,
      resourceId: a.resource.publicId,
    });
  };
};

/**
 * Locks the row before `applyWrite`, so a writer that read the same version
 * queues here and is refused before its write runs, rather than after a write
 * that reaches past the row (a document's stored text) has landed.
 */
const lockAtVersion = async (args: {
  table: VersionTable;
  resource: VersionedResourceRef;
  expectedVersion?: number | null;
  transaction: Transaction;
}): Promise<void> => {
  const { dbId, publicId, version } = args.resource;
  const locked = await args.table.resourceModel().findOne({
    where: { id: dbId },
    attributes: ['id', 'version'],
    lock: args.transaction.LOCK.UPDATE,
    transaction: args.transaction,
  });
  if (locked?.version === version) return;
  throw versionConflict({
    currentVersion: locked?.version ?? version,
    expectedVersion: args.expectedVersion ?? null,
    resourceLabel: args.table.resourceLabel,
    resourceId: publicId,
  });
};

const makeCommitConfigChange = (args: {
  table: VersionTable;
  assertWritable: ReturnType<typeof makeAssertWritable>;
  claimVersion: ReturnType<typeof makeClaimVersion>;
  writeVersion: ReturnType<typeof makeWriteVersion>;
}) => {
  const { resourceLabel } = args.table;
  const { assertWritable, claimVersion, writeVersion } = args;

  return async (a: CommitConfigChangeArgs): Promise<void> => {
    const { dbId, publicId, version: currentVersion } = a.resource;

    // Checked before any work: a caller writing against a version that has
    // already moved is refused whether or not its change would have altered
    // anything.
    assertWritable({
      resource: a.resource,
      expectedVersion: a.expectedVersion,
    });

    await db.sequelize.transaction(async (transaction) => {
      await lockAtVersion({
        table: args.table,
        resource: a.resource,
        expectedVersion: a.expectedVersion,
        transaction,
      });

      const { row, after } = await a.applyWrite({ transaction });

      if (isSameConfig(a.before, after)) return;

      const nextVersion = currentVersion + 1;

      const claimed = await claimVersion({
        resourceDbId: dbId,
        expected: currentVersion,
        next: nextVersion,
        transaction,
      });

      // `lockAtVersion` holds the row at `currentVersion`, so the claim cannot
      // lose; a lost one is a broken invariant, not a conflict to report.
      if (!claimed) {
        throw new Error(
          `${resourceLabel} '${publicId}' lost its version claim under lock.`
        );
      }

      await writeVersion({
        resourceDbId: dbId,
        version: nextVersion,
        config: after,
        label: a.label,
        createdByUserId: a.createdByUserId,
        transaction,
      });

      log(
        'commitConfigChange: %s id=%s bumped to version=%d',
        resourceLabel,
        publicId,
        nextVersion
      );

      // The claim stamps `updatedAt` too, and it is the only column a write
      // whose change lives outside the row (a document's file) touches. `raw`
      // because Sequelize silently drops a set on a timestamp attribute.
      row.set('version', nextVersion);
      const updatedAt = claimed.get('updatedAt');
      if (updatedAt !== undefined)
        row.set('updatedAt', updatedAt, { raw: true });
    });
  };
};

export const makeVersionStore = (args: VersionTable): VersionStore => {
  const writeVersion = makeWriteVersion(args);
  const claimVersion = makeClaimVersion(args);
  const assertWritable = makeAssertWritable(args);

  return {
    ...makeVersionRows(args),
    assertWritable,
    commitConfigChange: makeCommitConfigChange({
      table: args,
      assertWritable,
      claimVersion,
      writeVersion,
    }),
    foreignKey: args.foreignKey,
    versionModel: args.versionModel,
    writeVersion,
  };
};
