import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { type MappedGuardrail, updateGuardrail } from './guardrails';
import { guardrailVersionStore } from './guardrailVersionSnapshot';
import {
  type ArchivedVersionRow,
  configObject,
  makeVersionArchive,
  mapArchivedVersionFields,
  type VersionedResourceRef,
} from './resourceVersions';

const log = createDebug('soat:guardrails');

/**
 * Guardrail version history.
 *
 * The archive mechanics live in `resourceVersions.ts` and are shared with
 * agents; this module supplies the guardrail-specific adapters. Versions are
 * never written from here — they are archived by the shared write path in
 * `guardrails.ts`, so a REST edit and a formation apply leave identical history.
 *
 * Guardrails have no release/canary layer: a guardrail is evaluated against the
 * live policy by design, and splitting traffic across two policies would mean
 * deliberately under-enforcing one of them.
 */

type GuardrailInstance = InstanceType<(typeof db)['Guardrail']>;

// ── Mapping ──────────────────────────────────────────────────────────────

export const mapGuardrailVersion = (
  version: ArchivedVersionRow,
  guardrailPublicId: string
) => {
  return {
    guardrail_id: guardrailPublicId,
    ...mapArchivedVersionFields(version),
  };
};

// ── Lookup helpers ───────────────────────────────────────────────────────

const findGuardrailInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<GuardrailInstance> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const guardrail = await db.Guardrail.findOne({ where });
  // Cross-project access resolves here as "not found" rather than a 403, so a
  // guardrail's existence never leaks across a tenant boundary.
  if (!guardrail) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Guardrail '${args.id}' not found.`
    );
  }
  return guardrail as GuardrailInstance;
};

const toResourceRef = (guardrail: GuardrailInstance): VersionedResourceRef => {
  return {
    dbId: guardrail.id as number,
    publicId: guardrail.publicId,
    version: guardrail.version,
  };
};

/**
 * The guardrail adapter over the shared archive. `applyConfig` routes through
 * `updateGuardrail` rather than touching columns, so a restored document is
 * re-validated and archived by the same choke point as any other edit — and a
 * document identical to the live one is recognised as a no-op.
 */
const guardrailVersionArchive = makeVersionArchive({
  store: guardrailVersionStore,
  loadResource: async (args) => {
    return toResourceRef(await findGuardrailInstance(args));
  },
  mapVersion: mapGuardrailVersion,
  applyConfig: async (args): Promise<MappedGuardrail> => {
    const document = configObject(args.config.document);
    /* istanbul ignore next -- `document` is NOT NULL on the guardrail and every
       archived config is built by `buildGuardrailConfigSnapshot`, so a version
       without one means the row was edited outside the application. */
    if (!document) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Guardrail '${args.id}' has an archived version with no document.`
      );
    }

    return updateGuardrail({
      projectIds: args.projectIds,
      id: args.id,
      document,
      versionLabel: args.label,
      createdByUserId: args.createdByUserId,
    });
  },
});

// ── Read endpoints ───────────────────────────────────────────────────────

export const listGuardrailVersions = async (args: {
  projectIds?: number[];
  guardrailId: string;
  limit?: number;
  offset?: number;
}) => {
  log('listGuardrailVersions: guardrailId=%s', args.guardrailId);

  return guardrailVersionArchive.listVersions({
    projectIds: args.projectIds,
    resourceId: args.guardrailId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getGuardrailVersion = async (args: {
  projectIds?: number[];
  guardrailId: string;
  version: number;
}) => {
  log(
    'getGuardrailVersion: guardrailId=%s version=%d',
    args.guardrailId,
    args.version
  );

  return guardrailVersionArchive.getVersion({
    projectIds: args.projectIds,
    resourceId: args.guardrailId,
    version: args.version,
  });
};

export const restoreGuardrailVersion = async (args: {
  projectIds?: number[];
  guardrailId: string;
  version: number;
  label?: string | null;
  createdByUserId?: number | null;
}): Promise<MappedGuardrail> => {
  log(
    'restoreGuardrailVersion: guardrailId=%s version=%d',
    args.guardrailId,
    args.version
  );

  // Appends a new version rather than rewinding the counter, so an evaluation
  // record citing any version in between still resolves.
  return guardrailVersionArchive.restoreVersion({
    projectIds: args.projectIds,
    resourceId: args.guardrailId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });
};
