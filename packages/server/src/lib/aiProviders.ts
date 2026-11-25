import type { AiProviderSlug } from '@soat/postgresdb';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';
import { decryptValue } from 'src/lib/secrets';
import type { IsAllowedFn } from 'src/middleware/authProjectResolvers';

import { assertLinkedSecretUsable } from './agentModel';
import { assertAliasTargets } from './aiProviderAliasTargets';
import { assertAiProviderConfig } from './aiProviderConfigValidation';
import {
  assertModelAliases,
  assertModelOffered,
  forwardedProviderIds,
  forwardsEveryModel,
  type ModelAliases,
  type ModelEndpoint,
} from './aiProviderModelAliases';
import { assertAiProviderCarriesCredential } from './ambientCredentials';
import {
  assertModelInputLimits,
  type ModelInputLimits,
  readModelInputLimits,
} from './inputLimits';
import {
  assertModelInputModalities,
  type ModelInputModalities,
  readModelInputModalities,
} from './inputModalityGate';
import { type ProjectScope, projectScopeWhere } from './projectScope';
import {
  aiProviderReferences,
  type ReferenceReach,
} from './resourceReferences';
import { assertSecretUseAllowed } from './secretUse';

const getAiProviderIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Secret, as: 'secret' },
  ];
};

type AiProviderRow = InstanceType<(typeof db)['AiProvider']> & {
  project?: InstanceType<(typeof db)['Project']>;
  secret?: InstanceType<(typeof db)['Secret']> | null;
};

const aiProviders = makeResourceAccessor<AiProviderRow>({
  model: () => {
    return db.AiProvider;
  },
  includes: getAiProviderIncludes,
  label: 'AI provider',
});

const mapAiProvider = (instance: AiProviderRow) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    secret_id: instance.secret?.publicId ?? null,
    name: instance.name,
    provider: instance.provider,
    default_model: instance.defaultModel,
    base_url: instance.baseUrl ?? undefined,
    config: instance.config ?? undefined,
    model_aliases: instance.modelAliases ?? {},
    model_aliases_only: instance.modelAliasesOnly,
    model_input_modalities: instance.modelInputModalities ?? {},
    model_input_limits: instance.modelInputLimits ?? {},
    require_priced_model: instance.requirePricedModel,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export const listAiProviders = async (args: {
  projectIds: ProjectScope;
  limit?: number;
  cursor?: string;
}) => {
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds },
    where: projectScopeWhere({ projectIds: args.projectIds }),
    order: [['createdAt', 'ASC']],
    query: ({ where, limit, order }) => {
      return db.AiProvider.findAll({
        where,
        include: getAiProviderIncludes(),
        order,
        limit,
      });
    },
    map: mapAiProvider,
  });
};

export const getAiProvider = async (args: { id: string }) => {
  const provider = await aiProviders.findByPublicId({ id: args.id });
  if (!provider) return null;
  return mapAiProvider(provider);
};

/**
 * The linked secret's value, `''` when the row it names has none, so a link
 * that resolves to nothing still reads as a link rather than as no credential.
 */
const readLinkedSecretValue = async (
  secretId: number | null | undefined
): Promise<string | null> => {
  if (!secretId) return null;
  const secret = await db.Secret.findByPk(secretId);
  return secret?.encryptedValue ? decryptValue(secret.encryptedValue) : '';
};

const projectPublicIdOf = async (projectId: number): Promise<string> => {
  const project = await db.Project.findByPk(projectId, {
    attributes: ['publicId'],
    rejectOnEmpty: true,
  });
  return project.publicId;
};

const assertProviderCredential = async (args: {
  projectId: number;
  provider: AiProviderSlug;
  secretId?: number | null;
  modelAliases: ModelAliases | null;
  modelAliasesOnly: boolean;
}) => {
  if (forwardsEveryModel(args)) return;
  assertAiProviderCarriesCredential({
    ...args,
    project: await projectPublicIdOf(args.projectId),
  });
  if (args.provider !== 'bedrock' && args.provider !== 'vertex') return;
  assertLinkedSecretUsable({
    provider: args.provider,
    secretValue: await readLinkedSecretValue(args.secretId),
  });
};

/**
 * A `base_url` the caller chose receives the linked secret as its credential,
 * so linking the two needs `secrets:UseSecret` on the secret.
 */
const assertEndpointSecretUse = async (args: {
  secretId?: number | null;
  baseUrl?: string | null;
  projectId: number;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  if (!args.secretId || !args.baseUrl) return;
  const secret = await db.Secret.findByPk(args.secretId, {
    attributes: ['publicId'],
  });
  if (!secret) return;
  await assertSecretUseAllowed({
    secretIds: [secret.publicId],
    projectId: args.projectId,
    isAllowed: args.isAllowed,
  });
};

type ModelDeclarations = {
  modelInputModalities?: ModelInputModalities | null;
  modelInputLimits?: ModelInputLimits | null;
};

// What each model reads, declared by the record and enforced by the boundary.
const assertModelDeclarations = (args: ModelDeclarations): void => {
  assertModelInputModalities(args.modelInputModalities);
  assertModelInputLimits(args.modelInputLimits);
};

const storedModelDeclarations = (args: ModelDeclarations) => {
  return {
    modelInputModalities: args.modelInputModalities ?? null,
    modelInputLimits: args.modelInputLimits ?? null,
  };
};

export const createAiProvider = async (args: {
  projectId: number;
  secretId?: number;
  name: string;
  provider: AiProviderSlug;
  defaultModel: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
  modelAliases?: ModelAliases;
  modelAliasesOnly?: boolean;
  modelInputModalities?: ModelInputModalities;
  modelInputLimits?: ModelInputLimits;
  requirePricedModel?: boolean;
  isAllowed: IsAllowedFn;
}) => {
  await assertEndpointSecretUse(args);
  assertModelAliases(args.modelAliases);
  assertModelDeclarations(args);
  const aliasing = {
    modelAliases: args.modelAliases ?? null,
    modelAliasesOnly: args.modelAliasesOnly ?? false,
  };
  assertModelOffered({ aiProvider: aliasing, model: args.defaultModel });
  await assertAliasTargets({
    projectId: args.projectId,
    modelAliases: aliasing.modelAliases,
  });
  assertAiProviderConfig({
    provider: args.provider,
    baseUrl: args.baseUrl,
    config: args.config,
  });
  await assertProviderCredential({
    projectId: args.projectId,
    provider: args.provider,
    secretId: args.secretId,
    ...aliasing,
  });

  const instance = await db.AiProvider.create({
    projectId: args.projectId,
    secretId: args.secretId ?? null,
    name: args.name,
    provider: args.provider,
    defaultModel: args.defaultModel,
    baseUrl: args.baseUrl ?? null,
    config: args.config ?? null,
    modelAliases: args.modelAliases ?? null,
    modelAliasesOnly: args.modelAliasesOnly ?? false,
    ...storedModelDeclarations(args),
    requirePricedModel: args.requirePricedModel ?? false,
  });
  return mapAiProvider(await aiProviders.reload(instance));
};

type AiProviderFieldUpdates = {
  secretId?: number | null;
  name?: string;
  provider?: AiProviderSlug;
  defaultModel?: string;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
  modelAliases?: ModelAliases | null;
  modelAliasesOnly?: boolean;
  modelInputModalities?: ModelInputModalities | null;
  modelInputLimits?: ModelInputLimits | null;
  requirePricedModel?: boolean;
};

// The fields that say which models the provider serves and how.
const applyModelFields = (args: {
  instance: AiProviderRow;
  fields: AiProviderFieldUpdates;
}): void => {
  const { instance, fields } = args;
  if (fields.defaultModel !== undefined)
    instance.defaultModel = fields.defaultModel;
  if (fields.modelAliases !== undefined)
    instance.modelAliases = fields.modelAliases;
  if (fields.modelAliasesOnly !== undefined)
    instance.modelAliasesOnly = fields.modelAliasesOnly;
  if (fields.modelInputModalities !== undefined)
    instance.modelInputModalities = fields.modelInputModalities;
  if (fields.modelInputLimits !== undefined)
    instance.modelInputLimits = fields.modelInputLimits;
  if (fields.requirePricedModel !== undefined)
    instance.requirePricedModel = fields.requirePricedModel;
};

const applyAiProviderFields = (args: {
  instance: AiProviderRow;
  fields: AiProviderFieldUpdates;
}): void => {
  const { instance } = args;
  if (args.fields.name !== undefined) instance.name = args.fields.name;
  if (args.fields.provider !== undefined)
    instance.provider = args.fields.provider;
  if (args.fields.baseUrl !== undefined) instance.baseUrl = args.fields.baseUrl;
  if (args.fields.config !== undefined) instance.config = args.fields.config;
  if (args.fields.secretId !== undefined)
    instance.secretId = args.fields.secretId;
  applyModelFields(args);
};

export const updateAiProvider = async (args: {
  id: string;
  secretId?: number | null;
  name?: string;
  provider?: AiProviderSlug;
  defaultModel?: string;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
  modelAliases?: ModelAliases | null;
  modelAliasesOnly?: boolean;
  modelInputModalities?: ModelInputModalities | null;
  modelInputLimits?: ModelInputLimits | null;
  requirePricedModel?: boolean;
  isAllowed: IsAllowedFn;
}) => {
  const instance = await aiProviders.findByPublicId({ id: args.id });
  if (!instance) return null;
  assertModelAliases(args.modelAliases);
  assertModelDeclarations(args);

  applyAiProviderFields({ instance, fields: args });
  assertModelOffered({ aiProvider: instance, model: instance.defaultModel });
  if (args.modelAliases !== undefined) {
    await assertAliasTargets({
      projectId: instance.projectId,
      publicId: instance.publicId,
      modelAliases: instance.modelAliases,
    });
  }

  if (args.secretId !== undefined || args.baseUrl !== undefined) {
    await assertEndpointSecretUse({
      secretId: instance.secretId,
      baseUrl: instance.baseUrl,
      projectId: instance.projectId,
      isAllowed: args.isAllowed,
    });
  }

  // Read off the instance rather than off `args`: an update that changes only
  // `config` still has to be checked against the provider the record already
  // is, and one that changes only `provider` against the config it already has.
  assertAiProviderConfig({
    provider: instance.provider,
    baseUrl: instance.baseUrl,
    config: instance.config,
  });
  await assertProviderCredential({
    projectId: instance.projectId,
    provider: instance.provider,
    secretId: instance.secretId,
    modelAliases: instance.modelAliases,
    modelAliasesOnly: instance.modelAliasesOnly,
  });

  await instance.save();
  return mapAiProvider(await aiProviders.reload(instance));
};

/**
 * Refuses, at write time, a model a closed provider does not offer.
 * An `aiProviderId` that does not resolve is left to the caller's own
 * not-found guard.
 */
export const assertModelOfferedByProvider = async (args: {
  projectId: number;
  aiProviderId: unknown;
  model: unknown;
}): Promise<void> => {
  if (typeof args.model !== 'string' || args.model === '') return;
  if (typeof args.aiProviderId !== 'string' || args.aiProviderId === '') {
    return;
  }
  const row = await aiProviderReferences.find({
    id: args.aiProviderId,
    projectId: args.projectId,
    reach: 'shares',
  });
  if (row) assertModelOffered({ aiProvider: row, model: args.model });
};

/**
 * The provider's credential, for the project that is about to generate with it.
 *
 * `projectId` is required rather than optional because this is the one funnel
 * that hands out a decrypted provider secret: an optional filter is one a new
 * caller can leave off, and the write-time guards it backs up cannot reach a
 * row that is already stored. A provider in another project resolves to `null`,
 * exactly as one that does not exist, unless `reach` is `'shares'` and an
 * accepted share grants it; `grantee` then names `projectId`, so the model
 * built from it counts against the share and hides the vendor's failures.
 */
export const resolveAiProviderSecret = async (args: {
  aiProviderId: string;
  projectId: number;
  reach: ReferenceReach;
}) => {
  const instance = await aiProviderReferences.find({
    id: args.aiProviderId,
    projectId: args.projectId,
    reach: args.reach,
  });
  if (!instance) return null;

  const decryptedValue = await readLinkedSecretValue(instance.secretId);

  // A forwarded alias calls its target's endpoint; a target that does not
  // resolve is left out, and `buildModel` refuses the alias that names it.
  const targetRows = await aiProviderReferences.findMany({
    ids: forwardedProviderIds(instance.modelAliases),
    projectId: instance.projectId,
    reach: 'project',
  });
  const projectPublicId = await projectPublicIdOf(instance.projectId);
  const aliasTargets: Record<string, ModelEndpoint> = {};
  for (const [publicId, target] of targetRows) {
    aliasTargets[publicId] = {
      projectPublicId,
      provider: target.provider,
      baseUrl: target.baseUrl ?? undefined,
      config: target.config ?? undefined,
      secretValue: await readLinkedSecretValue(target.secretId),
    };
  }

  return {
    // Internal ids, for callers that must attribute usage to the exact provider
    // instance and its project (a project may hold several providers of the
    // same slug). Never surface these on an API response.
    id: instance.id as number,
    projectId: instance.projectId as number,
    projectPublicId,
    provider: instance.provider,
    defaultModel: instance.defaultModel,
    baseUrl: instance.baseUrl ?? undefined,
    config: instance.config ?? undefined,
    publicId: instance.publicId,
    modelAliases: instance.modelAliases,
    modelAliasesOnly: instance.modelAliasesOnly,
    modelInputModalities: readModelInputModalities(
      instance.modelInputModalities
    ),
    modelInputLimits: readModelInputLimits(instance.modelInputLimits),
    requirePricedModel: instance.requirePricedModel,
    secretValue: decryptedValue,
    aliasTargets,
    grantee: instance.projectId === args.projectId ? null : args.projectId,
  };
};
