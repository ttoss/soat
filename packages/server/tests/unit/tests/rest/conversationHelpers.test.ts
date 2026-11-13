import { buildConversationContext } from 'src/rest/v1/conversationHelpers';

describe('buildConversationContext', () => {
  test('returns base context when conversation has no tags', () => {
    const conversation = {
      id: 'conv_1',
      project_id: 'proj_1',
      tags: null,
    } as never;
    const ctx = buildConversationContext(conversation);
    expect(ctx).toEqual({ 'iam:ResourceType': 'conversation' });
  });

  test('includes resource tags when conversation has tags', () => {
    const conversation = {
      id: 'conv_1',
      project_id: 'proj_1',
      tags: { env: 'prod', team: 'backend' },
    } as never;
    const ctx = buildConversationContext(conversation);
    expect(ctx['iam:ResourceType']).toBe('conversation');
    expect(ctx['iam:ResourceTag/env']).toBe('prod');
    expect(ctx['iam:ResourceTag/team']).toBe('backend');
  });
});
