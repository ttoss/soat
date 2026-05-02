import {
  buildConversationContext,
  checkConversationAccess,
} from 'src/rest/v1/conversationHelpers';

describe('buildConversationContext', () => {
  test('returns base context when conversation has no tags', () => {
    const conversation = {
      id: 'conv_1',
      projectId: 'proj_1',
      tags: null,
    } as never;
    const ctx = buildConversationContext(conversation);
    expect(ctx).toEqual({ 'soat:ResourceType': 'conversation' });
  });

  test('includes resource tags when conversation has tags', () => {
    const conversation = {
      id: 'conv_1',
      projectId: 'proj_1',
      tags: { env: 'prod', team: 'backend' },
    } as never;
    const ctx = buildConversationContext(conversation);
    expect(ctx['soat:ResourceType']).toBe('conversation');
    expect(ctx['soat:ResourceTag/env']).toBe('prod');
    expect(ctx['soat:ResourceTag/team']).toBe('backend');
  });
});

describe('checkConversationAccess', () => {
  test('delegates to authUser.isAllowed and returns its result', async () => {
    const authUser = {
      isAllowed: jest.fn().mockResolvedValue(true),
    } as never;
    const conversation = {
      id: 'conv_1',
      projectId: 'proj_1',
      tags: null,
    } as never;

    const result = await checkConversationAccess(
      authUser,
      conversation,
      'conversations:GetConversation'
    );

    expect(result).toBe(true);
    expect(
      (authUser as never as { isAllowed: jest.Mock }).isAllowed
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPublicId: 'proj_1',
        action: 'conversations:GetConversation',
      })
    );
  });

  test('returns false when authUser.isAllowed returns false', async () => {
    const authUser = {
      isAllowed: jest.fn().mockResolvedValue(false),
    } as never;
    const conversation = {
      id: 'conv_2',
      projectId: 'proj_2',
      tags: { type: 'private' },
    } as never;

    const result = await checkConversationAccess(
      authUser,
      conversation,
      'conversations:UpdateConversation'
    );

    expect(result).toBe(false);
  });
});
