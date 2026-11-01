import type { AiProviderSlug } from '@soat/postgresdb';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { findModelRoutesReferencingProvider } from 'src/lib/modelRouteReferences';
import { paginatedList } from 'src/lib/pagination';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';
import { decryptValue } from 'src/lib/secrets';
import type { IsAllowedFn } from 'src/middleware/authProjectResolvers';

import { assertLinkedSecretUsable } from './agentModel';
import { assertAiProviderConfig } from './aiProviderConfigValidation';
import { assertAiProviderCarriesCredential } from './ambientCredentials';
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
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export const listAiProviders = async (args: {
  projectIds: number[];
  limit?: number;
  cursor?: string;
}) => {
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds },
    where: { projectId: args.projectIds },
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

const assertProviderCredential = async (args: {
  provider: AiProviderSlug;
  secretId?: number | null;
}) => {
  assertAiProviderCarriesCredential(args);
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

export const createAiProvider = async (args: {
  projectId: number;
  secretId?: number;
  name: string;
  provider: AiProviderSlug;
  defaultModel: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
  isAllowed: IsAllowedFn;
}) => {
  await assertEndpointSecretUse(args);
  assertAiProviderConfig({
    provider: args.provider,
    baseUrl: args.baseUrl,
    config: args.config,
  });
  await assertProviderCredential({
    provider: args.provider,
    secretId: args.secretId,
  });

  const instance = await db.AiProvider.create({
    projectId: args.projectId,
    secretId: args.secretId ?? null,
    name: args.name,
    provider: args.provider,
    defaultModel: args.defaultModel,
    baseUrl: args.baseUrl ?? null,
    config: args.config ?? null,
  });
  return mapAiProvider(await aiProviders.reload(instance));
};

export const updateAiProvider = async (args: {
  id: string;
  secretId?: number;
  name?: string;
  provider?: AiProviderSlug;
  defaultModel?: string;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
  isAllowed: IsAllowedFn;
}) => {
  const instance = await aiProviders.findByPublicId({ id: args.id });
  if (!instance) return null;

  if (args.name !== undefined) instance.name = args.name;
  if (args.provider !== undefined) instance.provider = args.provider;
  if (args.defaultModel !== undefined)
    instance.defaultModel = args.defaultModel;
  if (args.baseUrl !== undefined) instance.baseUrl = args.baseUrl;
  if (args.config !== undefined) instance.config = args.config;
  if (args.secretId !== undefined) instance.secretId = args.secretId;

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
    provider: instance.provider,
    secretId: instance.secretId,
  });

  await instance.save();
  return mapAiProvider(await aiProviders.reload(instance));
};

// A single provider can power many chats, so the 409 lists a workable sample
// rather than an unbounded blob; the counts still report true totals.
const DEPENDENT_ID_SAMPLE_CAP = 20;

// Hard references (chats/agents) always block deletion — removing a provider
// must never cascade into deleting someone's work. Soft dependents are
// bookkeeping meaningful only relative to the provider, so `force` clears them.
const collectAiProviderDependents = async (args: {
  aiProviderId: number;
  aiProviderPublicId: string;
  projectId: number;
}) => {
  const aiProviderId = args.aiProviderId;
  const where = { aiProviderId };
  const attributes = ['publicId'];

  const [chats, agents, modelRoutes] = await Promise.all([
    db.Chat.findAll({ where, attributes }),
    db.Agent.findAll({ where, attributes }),
    // A route target names its provider inside JSONB, so no FK protects it —
    // the reference is live all the same (see `modelRouteReferences`).
    findModelRoutesReferencingProvider({
      projectId: args.projectId,
      aiProviderPublicId: args.aiProviderPublicId,
    }),
  ]);

  const [priceOverrideCount, usageEventCount] = await Promise.all([
    db.PriceBook.count({ where }),
    db.UsageEvent.count({ where }),
  ]);

  const hardCount = chats.length + agents.length + modelRoutes.length;
  const softCount = priceOverrideCount + usageEventCount;

  const sample = (rows: { publicId: string }[]): string[] => {
    return rows.slice(0, DEPENDENT_ID_SAMPLE_CAP).map((r) => {
      return r.publicId;
    });
  };

  const meta = {
    chat_count: chats.length,
    chat_ids: sample(chats),
    agent_count: agents.length,
    agent_ids: sample(agents),
    model_route_count: modelRoutes.length,
    model_route_ids: sample(modelRoutes),
    price_override_count: priceOverrideCount,
    usage_event_count: usageEventCount,
    // True only when the block is caused solely by soft dependents, i.e. a
    // `force=true` retry would succeed. Hard references make this false.
    forcible: hardCount === 0,
  };

  return {
    chats,
    agents,
    modelRoutes,
    hardCount,
    softCount,
    meta,
  };
};

export const deleteAiProvider = async (args: {
  id: string;
  force?: boolean;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.id },
  });
  if (!instance) return null;

  const { chats, agents, modelRoutes, hardCount, softCount, meta } =
    await collectAiProviderDependents({
      aiProviderId: instance.id,
      aiProviderPublicId: instance.publicId,
      projectId: instance.projectId,
    });

  if (hardCount > 0) {
    const parts = [
      chats.length > 0 ? `${chats.length} chat(s)` : null,
      agents.length > 0 ? `${agents.length} agent(s)` : null,
      modelRoutes.length > 0 ? `${modelRoutes.length} model route(s)` : null,
    ].filter(Boolean);
    throw new DomainError(
      'AI_PROVIDER_HAS_DEPENDENTS',
      `AI provider '${args.id}' is in use by ${parts.join(', ')} and cannot be deleted. Delete or repoint them before deleting the provider (force does not override live references).`,
      meta
    );
  }

  if (softCount > 0 && !args.force) {
    throw new DomainError(
      'AI_PROVIDER_HAS_DEPENDENTS',
      `AI provider '${args.id}' has ${meta.price_override_count} price override(s) and ${meta.usage_event_count} usage record(s). Retry with force=true to delete its overrides and unlink usage history.`,
      meta
    );
  }

  // Price overrides are dropped as meaningless without the provider;
  // usage/generation rows survive with the link nulled, preserving the
  // as-billed receipt.
  const aiProviderId = instance.id;
  await db.sequelize.transaction(async (transaction) => {
    if (softCount > 0) {
      await db.PriceBook.destroy({ where: { aiProviderId }, transaction });
      await db.UsageEvent.update(
        { aiProviderId: null },
        { where: { aiProviderId }, transaction }
      );
    }
    await instance.destroy({ transaction });
  });

  return 'deleted' as const;
};

/**
 * The provider's credential, for the project that is about to generate with it.
 *
 * `projectId` is required rather than optional because this is the one funnel
 * that hands out a decrypted provider secret: an optional filter is one a new
 * caller can leave off, and the write-time guards it backs up cannot reach a
 * row that is already stored. A provider in another project resolves to `null`,
 * exactly as one that does not exist.
 */
export const resolveAiProviderSecret = async (args: {
  aiProviderId: string;
  projectId: number;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId, projectId: args.projectId },
  });
  if (!instance) return null;

  const decryptedValue = await readLinkedSecretValue(instance.secretId);

  return {
    // Internal ids, for callers that must attribute usage to the exact provider
    // instance and its project (a project may hold several providers of the
    // same slug). Never surface these on an API response.
    id: instance.id as number,
    projectId: instance.projectId as number,
    provider: instance.provider,
    defaultModel: instance.defaultModel,
    baseUrl: instance.baseUrl ?? undefined,
    config: instance.config ?? undefined,
    secretValue: decryptedValue,
  };
};
