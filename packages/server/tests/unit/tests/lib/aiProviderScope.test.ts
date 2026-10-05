import { resolveChatModel } from 'src/lib/chatCompletionModel';

/**
 * A stateless completion loads its provider for authorization before it
 * resolves a model, so the route answers an unknown `ai_provider_id` with `404`
 * first. Resolution failing after that check — the provider deleted in between
 * — is an interleaving no request drives deterministically, and the route maps
 * this exact message to its published `404`, so the message is pinned here.
 * Every reachable outcome is covered through `rest/aiProviderScope.test.ts`
 * and `rest/chats.test.ts`.
 */
describe('resolveChatModel', () => {
  test('a provider that no longer exists reports it', async () => {
    await expect(
      resolveChatModel({ aiProviderId: 'aip_doesnotexist000000' })
    ).rejects.toThrow('AI provider not found');
  });
});
