import type { Context } from 'src/Context';
import type { DomainError } from 'src/errors';
import type { getConversation } from 'src/lib/conversations';
import { buildSrn } from 'src/lib/iam';
import { buildResourceTagContext } from 'src/lib/tags';

import { requireAllowed } from './resourceAccess';

export type ConversationRecord = Awaited<ReturnType<typeof getConversation>>;

export const buildConversationContext = (
  conversation: NonNullable<ConversationRecord>
): Record<string, string> => {
  return buildResourceTagContext({
    resourceType: 'conversation',
    tags: conversation.tags,
  });
};

export const requireConversationAccess = async (args: {
  ctx: Context;
  conversation: NonNullable<ConversationRecord>;
  action: string;
  notFound: DomainError;
}): Promise<void> => {
  const { conversation } = args;
  await requireAllowed({
    ctx: args.ctx,
    check: {
      projectPublicId: conversation.project_id!,
      action: args.action,
      resource: buildSrn({
        projectPublicId: conversation.project_id!,
        resourceType: 'conversation',
        resourceId: conversation.id,
      }),
      context: buildConversationContext(conversation),
    },
    notFound: args.notFound,
  });
};
