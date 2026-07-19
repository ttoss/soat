import type { AiProviderSlug } from '@soat/postgresdb';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { decryptValue } from 'src/lib/secrets';

const getAiProviderIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Secret, as: 'secret' },
  ];
};

const mapAiProvider = (
  instance: InstanceType<(typeof db)['AiProvider']> & {
    project?: InstanceType<(typeof db)['Project']>;
    secret?: InstanceType<(typeof db)['Secret']> | null;
  }
) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    secretId: instance.secret?.publicId ?? null,
    name: instance.name,
    provider: instance.provider,
    defaultModel: instance.defaultModel,
    baseUrl: instance.baseUrl ?? undefined,
    config: instance.config ?? undefined,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export const listAiProviders = async (args: { projectIds: number[] }) => {
  const providers = await db.AiProvider.findAll({
    where: { projectId: args.projectIds },
    include: getAiProviderIncludes(),
  });
  return providers.map(mapAiProvider);
};

export const getAiProvider = async (args: { id: string }) => {
  const provider = await db.AiProvider.findOne({
    where: { publicId: args.id },
    include: getAiProviderIncludes(),
  });
  if (!provider) return null;
  return mapAiProvider(provider);
};

export const createAiProvider = async (args: {
  projectId: number;
  secretId?: number;
  name: string;
  provider: AiProviderSlug;
  defaultModel: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}) => {
  const instance = await db.AiProvider.create({
    projectId: args.projectId,
    secretId: args.secretId ?? null,
    name: args.name,
    provider: args.provider,
    defaultModel: args.defaultModel,
    baseUrl: args.baseUrl ?? null,
    config: args.config ?? null,
  });
  const withAssociations = await db.AiProvider.findOne({
    where: { id: instance.id },
    include: getAiProviderIncludes(),
  });
  return mapAiProvider(withAssociations!);
};

export const updateAiProvider = async (args: {
  id: string;
  secretId?: number;
  name?: string;
  provider?: AiProviderSlug;
  defaultModel?: string;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.id },
    include: getAiProviderIncludes(),
  });
  if (!instance) return null;

  if (args.name !== undefined) instance.name = args.name;
  if (args.provider !== undefined) instance.provider = args.provider;
  if (args.defaultModel !== undefined)
    instance.defaultModel = args.defaultModel;
  if (args.baseUrl !== undefined) instance.baseUrl = args.baseUrl;
  if (args.config !== undefined) instance.config = args.config;
  if (args.secretId !== undefined) instance.secretId = args.secretId;

  await instance.save();
  const refreshed = await db.AiProvider.findOne({
    where: { id: instance.id },
    include: getAiProviderIncludes(),
  });
  return mapAiProvider(refreshed!);
};

// Cap on how many offending public IDs we echo back in a 409. Hard references
// are usually few, but a single provider can power many chats — list a workable
// sample (the counts always report the true totals) rather than an unbounded
// blob.
const DEPENDENT_ID_SAMPLE_CAP = 20;

// Splits everything that references a provider into two policy classes and
// builds the 409 `meta`. Hard references (chats/agents/discussions) are
// independently-valuable resources that *use* the provider — they always block
// deletion, because deleting a provider must never cascade into deleting
// someone's work. Soft dependents (price overrides, usage/generation records,
// discussion participants) are bookkeeping that only has meaning relative to the
// provider — they block by default but clear under `force`.
const collectAiProviderDependents = async (aiProviderId: number) => {
  const where = { aiProviderId };
  const attributes = ['publicId'];

  const [chats, agents, discussions] = await Promise.all([
    db.Chat.findAll({ where, attributes }),
    db.Agent.findAll({ where, attributes }),
    db.Discussion.findAll({ where, attributes }),
  ]);

  const [priceOverrideCount, usageEventCount, discussionParticipantCount] =
    await Promise.all([
      db.PriceBook.count({ where }),
      db.UsageEvent.count({ where }),
      db.DiscussionParticipant.count({ where }),
    ]);

  const hardCount = chats.length + agents.length + discussions.length;
  const softCount =
    priceOverrideCount + usageEventCount + discussionParticipantCount;

  const sample = (rows: { publicId: string }[]): string[] => {
    return rows.slice(0, DEPENDENT_ID_SAMPLE_CAP).map((r) => {
      return r.publicId;
    });
  };

  const meta = {
    chatCount: chats.length,
    chatIds: sample(chats),
    agentCount: agents.length,
    agentIds: sample(agents),
    discussionCount: discussions.length,
    discussionIds: sample(discussions),
    priceOverrideCount,
    usageEventCount,
    discussionParticipantCount,
    // True only when the block is caused solely by soft dependents, i.e. a
    // `force=true` retry would succeed. Hard references make this false.
    forcible: hardCount === 0,
  };

  return { chats, agents, discussions, hardCount, softCount, meta };
};

export const deleteAiProvider = async (args: {
  id: string;
  force?: boolean;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.id },
  });
  if (!instance) return null;

  const { chats, agents, discussions, hardCount, softCount, meta } =
    await collectAiProviderDependents(instance.id);

  if (hardCount > 0) {
    const parts = [
      chats.length > 0 ? `${chats.length} chat(s)` : null,
      agents.length > 0 ? `${agents.length} agent(s)` : null,
      discussions.length > 0 ? `${discussions.length} discussion(s)` : null,
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
      `AI provider '${args.id}' has ${meta.priceOverrideCount} price override(s), ${meta.usageEventCount} usage record(s), and ${meta.discussionParticipantCount} discussion participant(s). Retry with force=true to delete its overrides and unlink usage/participant history.`,
      meta
    );
  }

  // No hard references, and either no soft dependents or force=true: clear the
  // bookkeeping and remove the provider atomically. Price overrides are dropped
  // (meaningless without the provider); usage/generation records and discussion
  // participants keep their rows with the provider link nulled, preserving the
  // as-billed receipt and history.
  const aiProviderId = instance.id;
  await db.sequelize.transaction(async (transaction) => {
    if (softCount > 0) {
      await db.PriceBook.destroy({ where: { aiProviderId }, transaction });
      await db.UsageEvent.update(
        { aiProviderId: null },
        { where: { aiProviderId }, transaction }
      );
      await db.DiscussionParticipant.update(
        { aiProviderId: null },
        { where: { aiProviderId }, transaction }
      );
    }
    await instance.destroy({ transaction });
  });

  return 'deleted' as const;
};

export const resolveAiProviderSecret = async (args: {
  aiProviderId: string;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId },
  });
  if (!instance) return null;

  let decryptedValue: string | null = null;
  if (instance.secretId) {
    const secret = await db.Secret.findByPk(instance.secretId);
    if (secret?.encryptedValue) {
      decryptedValue = decryptValue(secret.encryptedValue);
    }
  }

  return {
    provider: instance.provider,
    defaultModel: instance.defaultModel,
    baseUrl: instance.baseUrl ?? undefined,
    config: instance.config ?? undefined,
    secretValue: decryptedValue,
  };
};
