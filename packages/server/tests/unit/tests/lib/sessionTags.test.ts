import { db } from 'src/db';
import { getSessionTags, updateSessionTags } from 'src/lib/sessionTags';

// The `tags` column defaults to `{}` on every session created through the
// API (see Session model), so the `?? {}` fallback in both functions is
// only reachable for a row whose `tags` is explicitly `null` — a state the
// nullable column allows but no REST write path produces. Exercised
// directly here via a raw DB row, rather than through the entry point.
describe('sessionTags — null tags column default', () => {
  let agentId: number;
  let projectId: number;
  let conversationId: number;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'SessionTags Lib Test' });
    projectId = project.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'SessionTags Provider',
      provider: 'ollama',
      defaultModel: 'test-model',
    });

    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'SessionTags Agent',
    });
    agentId = agent.id;

    const conversation = await db.Conversation.create({ projectId });
    conversationId = conversation.id;
  });

  const createSessionWithNullTags = async () => {
    const session = await db.Session.create({
      projectId,
      agentId,
      conversationId,
      tags: null,
    });
    return session.publicId;
  };

  test('getSessionTags falls back to {} when the column is null', async () => {
    const sessionId = await createSessionWithNullTags();

    const tags = await getSessionTags({ agentId, sessionId });

    expect(tags).toEqual({});
  });

  test('updateSessionTags merge falls back to {} when the column is null', async () => {
    const sessionId = await createSessionWithNullTags();

    const tags = await updateSessionTags({
      agentId,
      sessionId,
      tags: { team: 'support' },
      merge: true,
    });

    expect(tags).toEqual({ team: 'support' });
  });
});
