import { db } from 'src/db';
import * as discussionCompletion from 'src/lib/discussionCompletion';
import { runDiscussion } from 'src/lib/discussionRuns';
import { createDiscussion } from 'src/lib/discussions';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// `runDiscussion`'s `traceId` param is set only from the agent-tool-invocation
// path (`resolveDiscussionTool` in agentToolResolver.ts) — there is no REST
// entry point for it, and driving a real agent tool-call negotiation through
// HTTP to exercise it end-to-end would require scripting a model tool-call
// response, which this repo's test infrastructure has no fixture for. Tested
// directly here instead (see discussions.md for the documented contract).
describe('runDiscussion — traceId propagation', () => {
  let projectDbId: number;
  let aiProviderId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    const adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'runDiscussion traceId Test Project' });

    const project = await db.Project.findOne({
      where: { publicId: projectRes.body.id },
    });
    projectDbId = project!.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectRes.body.id,
        name: 'runDiscussion traceId Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a tool-invoked run records the invoking generation trace on the run', async () => {
    jest
      .spyOn(discussionCompletion, 'runDiscussionCompletion')
      .mockResolvedValue('solo outcome');

    const discussion = await createDiscussion({
      projectId: projectDbId,
      name: 'Trace propagation discussion',
      aiProviderId,
      participants: [{ name: 'Solo', prompt: 'think' }],
    });

    const run = await runDiscussion({
      discussionId: discussion.id,
      topic: 'Q',
      traceId: 'trc_calling_generation',
    });

    expect(run.traceId).toBe('trc_calling_generation');
  });

  test('a directly-invoked run (no traceId given) leaves trace_id null', async () => {
    jest
      .spyOn(discussionCompletion, 'runDiscussionCompletion')
      .mockResolvedValue('solo outcome');

    const discussion = await createDiscussion({
      projectId: projectDbId,
      name: 'No trace discussion',
      aiProviderId,
      participants: [{ name: 'Solo', prompt: 'think' }],
    });

    const run = await runDiscussion({
      discussionId: discussion.id,
      topic: 'Q',
    });

    expect(run.traceId).toBeNull();
  });
});
