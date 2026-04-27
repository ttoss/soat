import type { Context } from 'src/Context';
import type { getConversation } from 'src/lib/conversations';
import { buildSrn } from 'src/lib/iam';

export type ConversationRecord = Awaited<ReturnType<typeof getConversation>>;

export const buildConversationContext = (
  conversation: NonNullable<ConversationRecord>
): Record<string, string> => {
  const ctx: Record<string, string> = { 'soat:ResourceType': 'conversation' };
  if (conversation.tags) {
    for (const [k, v] of Object.entries(conversation.tags)) {
      ctx[`soat:ResourceTag/${k}`] = v as string;
    }
  }
  return ctx;
};

export const checkConversationAccess = async (
  authUser: NonNullable<Context['authUser']>,
  conversation: NonNullable<ConversationRecord>,
  action: string
): Promise<boolean> => {
  const srn = buildSrn({
    projectPublicId: conversation.projectId!,
    resourceType: 'conversation',
    resourceId: conversation.id,
  });
  return authUser.isAllowed({
    projectPublicId: conversation.projectId!,
    action,
    resource: srn,
    context: buildConversationContext(conversation),
  });
};
