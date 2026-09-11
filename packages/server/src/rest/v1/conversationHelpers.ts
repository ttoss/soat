import type { Context } from 'src/Context';
import type { getConversation } from 'src/lib/conversations';
import { buildSrn } from 'src/lib/iam';
import { buildResourceTagContext } from 'src/lib/tags';

export type ConversationRecord = Awaited<ReturnType<typeof getConversation>>;

export const buildConversationContext = (
  conversation: NonNullable<ConversationRecord>
): Record<string, string> => {
  return buildResourceTagContext({
    resourceType: 'conversation',
    tags: conversation.tags,
  });
};

export const checkConversationAccess = async (
  authUser: NonNullable<Context['authUser']>,
  conversation: NonNullable<ConversationRecord>,
  action: string
): Promise<boolean> => {
  const srn = buildSrn({
    projectPublicId: conversation.project_id!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  return authUser.isAllowed({
    projectPublicId: conversation.project_id!,
    action,
    resource: srn,
    context: buildConversationContext(conversation),
  });
};
