import { getSessionTags, updateSessionTags } from 'src/lib/sessionTags';

// The session tags routes resolve (and 404) the session before calling these
// lib functions, so the lib's own "session not found" guard is only reachable
// directly — exercised here to keep it covered and to document the contract.
describe('sessionTags lib — missing session guard', () => {
  test('getSessionTags throws RESOURCE_NOT_FOUND for a missing session', async () => {
    await expect(
      getSessionTags({ agentId: 999999, sessionId: 'sess_missing000000' })
    ).rejects.toThrow(/not found/i);
  });

  test('updateSessionTags throws RESOURCE_NOT_FOUND for a missing session', async () => {
    await expect(
      updateSessionTags({
        agentId: 999999,
        sessionId: 'sess_missing000000',
        tags: { foo: 'bar' },
        merge: true,
      })
    ).rejects.toThrow(/not found/i);
  });
});
