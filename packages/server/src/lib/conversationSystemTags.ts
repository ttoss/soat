import { db } from '../db';

/**
 * The provenance a conversation turn carries in its tag bag: which
 * conversation it belongs to, whose conversation it is, which agent produced
 * it, and whether it was said or answered.
 *
 * Tags rather than columns because one filter then reaches both knowledge
 * stores — `tags` is the only search filter that scopes documents and memories
 * alike — and because an IAM `soat:ResourceTag/system.actor` condition fences
 * an actor's turns without any code knowing about conversations.
 *
 * `system.actor` is the conversation's **owner**, not the message's author: the
 * owner is stable for the whole conversation and is what an isolation policy
 * names. Per-message authorship is `actor_id` on the message.
 */
export const conversationMessageTags = (args: {
  conversationPublicId: string;
  ownerActorPublicId?: string | null;
  agentPublicId?: string | null;
  role: string;
}): Record<string, string> => {
  const tags: Record<string, string> = {
    'system.conversation': args.conversationPublicId,
    'system.role': args.role,
  };
  if (args.ownerActorPublicId) tags['system.actor'] = args.ownerActorPublicId;
  if (args.agentPublicId) tags['system.agent'] = args.agentPublicId;
  return tags;
};

type ConversationWithActor = InstanceType<(typeof db)['Conversation']> & {
  actor?: InstanceType<(typeof db)['Actor']> | null;
};

/** The owner's public id, or null for a conversation nobody owns. */
export const ownerActorPublicId = (
  conversation: ConversationWithActor
): string | null => {
  return conversation.actor?.publicId ?? null;
};

/**
 * The stamp a fact learned in a conversation carries, so it answers to the
 * same `system.conversation` / `system.actor` filter the conversation's raw
 * turns do. Empty for a turn that belongs to no conversation — a bare agent
 * generation has none.
 */
export const conversationProvenanceTags = async (args: {
  conversationPublicId?: string | null;
}): Promise<Record<string, string>> => {
  if (!args.conversationPublicId) return {};

  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationPublicId },
    include: [{ model: db.Actor, as: 'actor' }],
  });
  if (!conversation) return {};

  const tags: Record<string, string> = {
    'system.conversation': conversation.publicId,
  };
  const owner = ownerActorPublicId(conversation);
  if (owner) tags['system.actor'] = owner;
  return tags;
};
