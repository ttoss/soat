import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { findModelRoutesReferencingProvider } from 'src/lib/modelRouteReferences';

import { findProvidersForwardingTo } from './aiProviderAliasTargets';
import { countAcceptedShares, revokeResourceShares } from './shareLifecycle';

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
  // A grantee's chats and agents are not the publisher's to see or repoint:
  // the accepted shares stand for them, and `force` revokes those.
  const ownWhere = { aiProviderId, projectId: args.projectId };
  const attributes = ['publicId'];

  const [chats, agents, modelRoutes, forwarding] = await Promise.all([
    db.Chat.findAll({ where: ownWhere, attributes }),
    db.Agent.findAll({ where: ownWhere, attributes }),
    // A route target names its provider inside JSONB, so no FK protects it —
    // the reference is live all the same (see `modelRouteReferences`).
    findModelRoutesReferencingProvider({
      projectId: args.projectId,
      aiProviderPublicId: args.aiProviderPublicId,
    }),
    // So is an alias that forwards to it.
    findProvidersForwardingTo({
      projectId: args.projectId,
      targetPublicId: args.aiProviderPublicId,
    }),
  ]);

  const [priceOverrideCount, usageEventCount, acceptedShareCount] =
    await Promise.all([
      db.PriceBook.count({ where }),
      db.UsageEvent.count({ where }),
      countAcceptedShares({
        resourceType: 'aiProvider',
        resourceId: args.aiProviderPublicId,
      }),
    ]);

  const hardCount =
    chats.length + agents.length + modelRoutes.length + forwarding.length;
  const softCount = priceOverrideCount + usageEventCount + acceptedShareCount;

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
    ai_provider_count: forwarding.length,
    ai_provider_ids: forwarding.slice(0, DEPENDENT_ID_SAMPLE_CAP),
    price_override_count: priceOverrideCount,
    usage_event_count: usageEventCount,
    accepted_share_count: acceptedShareCount,
    // True only when the block is caused solely by soft dependents, i.e. a
    // `force=true` retry would succeed. Hard references make this false.
    forcible: hardCount === 0,
  };

  return {
    chats,
    agents,
    modelRoutes,
    forwarding,
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

  const { chats, agents, modelRoutes, forwarding, hardCount, softCount, meta } =
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
      forwarding.length > 0
        ? `${forwarding.length} AI provider(s) whose model_aliases forward to it`
        : null,
    ].filter(Boolean);
    throw new DomainError(
      'AI_PROVIDER_HAS_DEPENDENTS',
      `AI provider '${args.id}' is in use by ${parts.join(', ')} and cannot be deleted, with or without force.`,
      meta
    );
  }

  if (softCount > 0 && !args.force) {
    throw new DomainError(
      'AI_PROVIDER_HAS_DEPENDENTS',
      `AI provider '${args.id}' has ${meta.price_override_count} price override(s), ${meta.usage_event_count} usage record(s) and ${meta.accepted_share_count} accepted share(s), which block its deletion without force=true.`,
      meta
    );
  }

  await revokeResourceShares({
    resourceType: 'aiProvider',
    resourceId: instance.publicId,
  });

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
