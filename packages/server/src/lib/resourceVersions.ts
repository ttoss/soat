import { isDeepStrictEqual } from 'node:util';

import type { Model, ModelCtor } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import type { ResourceIncludes } from './modelIncludes';
import { paginatedList, type PaginatedResult } from './pagination';

const log = createDebug('soat:versions');

/**
 * The shared resource-versioning engine (#877, layer 1).
 *
 * Agents and guardrails both keep an append-only archive of their config: an
 * immutable `(resource_id, version, config)` row written by the resource's own
 * write path, plus list / get / restore. The two had grown as parallel copies —
 * `AgentVersion`'s doc comment literally said "Mirrors `GuardrailVersion`" — so
 * the mechanism lives here once and each resource supplies only the config
 * projection, `applyConfig`, `mapVersion` and `loadResource`.
 *
 * Version *tables* stay per resource so the foreign key to the parent is a real
 * one; only the lib code is shared.
 *
 * Two factories because {@link makeVersionStore} is the write side and knows
 * nothing of the parent beyond its row id, while {@link makeVersionArchive}
 * adds read, restore and release and must reach the resource's update path.
 * Keeping them apart is what lets `agents.ts` archive a version without
 * importing `agentVersions.ts`, which imports `agents.ts` back.
 */

/**
 * An archived configuration, in the wire (snake_case) shape the owning
 * resource's OpenAPI spec documents. Opaque to this module: it is produced from,
 * and fed back into, the resource's write path as a value.
 */
export type ConfigSnapshot = Record<string, unknown>;

/**
 * The columns every version table carries — the only shape this engine knows
 * about. A concrete row (`AgentVersion`, `GuardrailVersion`) is a subtype, and
 * the engine deliberately stays at this level rather than being generic over the
 * row: Sequelize resolves `where` clauses against `Attributes<M>`, which cannot
 * be checked while `M` is an unresolved type parameter, and the per-resource
 * columns (`agentId`, `guardrailId`) are exactly what the engine must not name.
 *
 * `config` is deliberately `object` rather than `ConfigSnapshot` — it is what
 * Sequelize declares for a JSONB column, and `readArchivedConfig` is the one
 * place it is narrowed.
 */
export type ArchivedVersionRow = Model & {
  publicId: string;
  version: number;
  config: object;
  label: string | null;
  createdBy: { publicId: string } | null;
  createdAt: Date;
};

/** Identity of the resource that owns an archive, resolved once per call. */
export type VersionedResourceRef = {
  /** Internal row id — the archive's foreign key. Never leaves this layer. */
  dbId: number;
  publicId: string;
  /** The resource's current config version. */
  version: number;
};

/**
 * Narrows any versioned row to the archive's reference shape.
 *
 * Four modules had written this out identically. It reads only `id`,
 * `publicId`, and `version` — present on every versioned row — so it moves a
 * **whole row** in and a fixed three-key struct out, naming no resource field.
 */
export const toResourceRef = (row: {
  id?: unknown;
  publicId: string;
  version: number;
}): VersionedResourceRef => {
  return {
    dbId: row.id as number,
    publicId: row.publicId,
    version: row.version,
  };
};

// ── Building a snapshot ───────────────────────────────────────────────────

/**
 * Projects a resource's wire response down to its configuration by dropping a
 * set of non-config keys.
 *
 * Only top-level keys are inspected, and only to decide whether to copy them —
 * no key is rewritten and no value descended into, so nested caller-authored
 * payloads are copied as values (`.claude/rules/case-convention.md`).
 *
 * Stated as an exclusion rather than an allowlist: a field forgotten here lands
 * in snapshots automatically so `restore` keeps working, whereas an allowlist
 * would silently stop restoring it. This direction's failure mode is loud — a
 * non-config field leaking in makes every update look like a change.
 */
export const projectConfigSnapshot = (args: {
  resource: Record<string, unknown>;
  nonConfigFields: ReadonlySet<string>;
}): ConfigSnapshot => {
  const config: ConfigSnapshot = {};
  for (const [key, value] of Object.entries(args.resource)) {
    if (!args.nonConfigFields.has(key)) {
      config[key] = value;
    }
  }
  return config;
};

/** True when two snapshots describe the same configuration. */
const isSameConfig = (
  before: ConfigSnapshot,
  after: ConfigSnapshot
): boolean => {
  return isDeepStrictEqual(before, after);
};

// An archived config is untyped JSON, and its consumers replace the whole
// config — so "absent" must read as "cleared", never "leave as is". Expressed
// once here instead of each call site pairing a `toNullableX` with a `?? null`.

export const configString = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

export const configNumber = (value: unknown): number | null => {
  return typeof value === 'number' ? value : null;
};

export const configObject = (value: unknown): object | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
};

export const configArray = <T>(value: unknown): T[] | null => {
  return Array.isArray(value) ? (value as T[]) : null;
};

export const configStringOrObject = (
  value: unknown
): string | object | null => {
  return typeof value === 'string' ? value : configObject(value);
};

export const configBoolean = (value: unknown): boolean => {
  return value === true;
};

/**
 * The fields a version response carries for every versioned resource. The
 * resource's own mapper adds the key naming its parent (`agent_id`,
 * `guardrail_id`) so that name appears literally in that module and stays
 * greppable, per `.claude/rules/case-convention.md`.
 */
export const mapArchivedVersionFields = (row: {
  publicId: string;
  version: number;
  config: object;
  label: string | null;
  createdBy: { publicId: string } | null;
  createdAt: Date;
}) => {
  return {
    id: row.publicId,
    version: row.version,
    config: row.config,
    label: row.label,
    created_by: row.createdBy?.publicId ?? null,
    created_at: row.createdAt,
  };
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
  createdByUserId?: number | null;
};

type ArchiveConfigChangeArgs = {
  resourceDbId: number;
  currentVersion: number;
  before: ConfigSnapshot;
  after: ConfigSnapshot;
  label?: string | null;
  createdByUserId?: number | null;
  bumpVersion: (nextVersion: number) => Promise<void>;
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
  archiveConfigChange: (args: ArchiveConfigChangeArgs) => Promise<void>;
  assertVersionsExist: (args: AssertVersionsExistArgs) => Promise<void>;
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
export const makeVersionStore = (args: VersionTable): VersionStore => {
  const { resourceLabel, versionModel, foreignKey } = args;
  const rows = makeVersionRows(args);

  /**
   * Archives one configuration. Called only from the resource's shared lib write
   * path, which is what makes a REST edit and a formation apply indistinguishable
   * here — both leave identical history.
   */
  const writeVersion = async (a: WriteVersionArgs): Promise<void> => {
    log(
      'writeVersion: %s dbId=%d version=%d label=%s',
      resourceLabel,
      a.resourceDbId,
      a.version,
      a.label ?? null
    );

    await versionModel().create({
      [foreignKey]: a.resourceDbId,
      version: a.version,
      config: a.config,
      label: a.label ?? null,
      createdByUserId: a.createdByUserId ?? null,
    });
  };

  /**
   * Archives the post-write config as a new version, but only when the write
   * actually changed it.
   *
   * The comparison runs on the serialized config rather than on the incoming
   * fields, so it is immune to a request that sets a field to the value it
   * already held — including the whole-config replacement `restore` performs,
   * which is why restoring the live config is a genuine no-op instead of an
   * endless version chain.
   *
   * `bumpVersion` is supplied by the resource because the counter lives on the
   * parent row, which this layer deliberately never touches.
   */
  const archiveConfigChange = async (
    a: ArchiveConfigChangeArgs
  ): Promise<void> => {
    if (isSameConfig(a.before, a.after)) return;

    const nextVersion = a.currentVersion + 1;
    await a.bumpVersion(nextVersion);

    await writeVersion({
      resourceDbId: a.resourceDbId,
      version: nextVersion,
      config: a.after,
      label: a.label,
      createdByUserId: a.createdByUserId,
    });
  };

  return {
    ...rows,
    archiveConfigChange,
    foreignKey,
    versionModel,
    writeVersion,
  };
};

// ── The archive: the endpoints a versioned resource exposes ───────────────

/** The per-resource adapters the archive is built from. */
type ArchiveAdapter<TMappedVersion, TMappedResource> = {
  store: VersionStore;
  /** Project-scoped parent lookup. Throws `RESOURCE_NOT_FOUND` when absent. */
  loadResource: (a: {
    projectIds?: number[];
    id: string;
  }) => Promise<VersionedResourceRef>;
  /** Wire mapper for one archived version. */
  mapVersion: (
    row: ArchivedVersionRow,
    resourcePublicId: string
  ) => TMappedVersion;
  /** Writes an archived config back through the resource's own update path. */
  applyConfig: (a: {
    projectIds?: number[];
    id: string;
    config: ConfigSnapshot;
    label: string | null;
    createdByUserId?: number | null;
  }) => Promise<TMappedResource>;
};

type ListVersionsArgs = {
  projectIds?: number[];
  resourceId: string;
  limit?: number;
  offset?: number;
};

type GetVersionArgs = {
  projectIds?: number[];
  resourceId: string;
  version: number;
};

type RestoreVersionArgs = GetVersionArgs & {
  label?: string | null;
  createdByUserId?: number | null;
};

/** The archive's read side: list and fetch, no writes. */
const makeVersionReads = <TMappedVersion, TMappedResource>(
  args: ArchiveAdapter<TMappedVersion, TMappedResource>
) => {
  const { store } = args;

  const listVersions = async (
    a: ListVersionsArgs
  ): Promise<PaginatedResult<TMappedVersion>> => {
    log('listVersions: id=%s', a.resourceId);

    const resource = await args.loadResource({
      projectIds: a.projectIds,
      id: a.resourceId,
    });

    return paginatedList({
      limit: a.limit,
      offset: a.offset,
      query: ({ limit, offset }) => {
        return store.versionModel().findAndCountAll({
          where: { [store.foreignKey]: resource.dbId },
          include: store.versionInclude(),
          // Ordered by the version counter, not a timestamp: two versions can
          // share a `createdAt`, and a non-deterministic page boundary in
          // history is worse than useless.
          order: [['version', 'DESC']],
          distinct: true,
          limit,
          offset,
        });
      },
      map: (row) => {
        return args.mapVersion(row, resource.publicId);
      },
    });
  };

  const getVersion = async (a: GetVersionArgs): Promise<TMappedVersion> => {
    log('getVersion: id=%s version=%d', a.resourceId, a.version);

    const resource = await args.loadResource({
      projectIds: a.projectIds,
      id: a.resourceId,
    });
    const row = await store.findVersionRow({ resource, version: a.version });

    return args.mapVersion(row, resource.publicId);
  };

  return { getVersion, listVersions };
};

/**
 * Builds the read and restore operations for one versioned resource on top of
 * its {@link makeVersionStore}.
 */
export const makeVersionArchive = <TMappedVersion, TMappedResource>(
  args: ArchiveAdapter<TMappedVersion, TMappedResource>
) => {
  const { store } = args;
  const reads = makeVersionReads(args);

  /**
   * Writes an archived config back through the resource's ordinary update path.
   *
   * Going through that path rather than touching columns directly buys three
   * things: the config is re-validated (a tool, provider or guardrail deleted
   * since the snapshot was taken fails loudly instead of writing a broken row),
   * the resulting version is archived by the same choke point as any other edit,
   * and a config identical to the live one is recognised as a no-op.
   */
  const applyArchivedVersion = async (
    a: GetVersionArgs & { label: string; createdByUserId?: number | null }
  ): Promise<TMappedResource> => {
    const resource = await args.loadResource({
      projectIds: a.projectIds,
      id: a.resourceId,
    });
    const row = await store.findVersionRow({ resource, version: a.version });

    return args.applyConfig({
      projectIds: a.projectIds,
      id: a.resourceId,
      config: store.readArchivedConfig(row),
      label: a.label,
      createdByUserId: a.createdByUserId,
    });
  };

  const restoreVersion = async (
    a: RestoreVersionArgs
  ): Promise<TMappedResource> => {
    log('restoreVersion: id=%s version=%d', a.resourceId, a.version);

    // Appends a new version rather than rewinding the counter.
    return applyArchivedVersion({
      projectIds: a.projectIds,
      resourceId: a.resourceId,
      version: a.version,
      label: a.label ?? `restored from v${a.version}`,
      createdByUserId: a.createdByUserId,
    });
  };

  return {
    ...reads,
    applyArchivedVersion,
    restoreVersion,
  };
};
