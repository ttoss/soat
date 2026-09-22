import type { Model } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { paginatedList, type PaginatedResult } from './pagination';
import type { VersionStore } from './resourceVersionStore';

const log = createDebug('soat:versions');

/**
 * The shared resource-versioning engine, layer 1.
 *
 * Agents and guardrails both keep an append-only archive of their config: an
 * immutable `(resource_id, version, config)` row written by the resource's own
 * write path, plus list / get / restore. The two are the same mechanism, so it
 * lives here once and each resource supplies only the config
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

// The write side lives in `resourceVersionStore.ts`; re-exported here so a
// resource reaches the whole engine through one module.
export type {
  VersionedResourceRow,
  VersionStore,
} from './resourceVersionStore';
export { makeVersionStore } from './resourceVersionStore';
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
    /** The archived version being written back. */
    version: number;
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
      version: a.version,
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
