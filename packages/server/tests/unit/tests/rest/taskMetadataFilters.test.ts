import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * `GET /tasks?metadata=` asks the grammar `documentMetadataFilters.test.ts`
 * pins down; this suite pins that the task list reads it the same way.
 */
describe('Task metadata filters', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let workflowId: string;
  const ids: Record<string, string> = {};

  const list = (query: Record<string, string>, token = userToken) => {
    return authenticatedTestClient(token).get('/api/v1/tasks').query(query);
  };

  const listIds = async (query: Record<string, string>) => {
    const response = await list({ workflow_id: workflowId, ...query });
    expect(response.status).toBe(200);
    return response.body.data
      .map((task: { id: string }) => {
        return task.id;
      })
      .sort();
  };

  const idsOf = (...names: string[]) => {
    return names
      .map((name) => {
        return ids[name];
      })
      .sort();
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taskmetafilter',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:ListTasks',
        'tasks:TransitionTask',
      ],
      createOtherProject: true,
      createNoPermUser: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    const workflow = await authenticatedTestClient(userToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'task-metadata-filters',
        states: [
          { name: 'open', initial: true },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
      });
    expect(workflow.status).toBe(201);
    workflowId = workflow.body.id;

    const create = async (args: { name: string; metadata?: unknown }) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowId,
          title: args.name,
          metadata: args.metadata,
        });
      expect(response.status).toBe(201);
      ids[args.name] = response.body.id;
    };

    await create({
      name: 'zendesk42',
      metadata: { source: 'zendesk', external_id: '42', priority: 2 },
    });
    await create({
      name: 'zendesk7',
      metadata: { source: 'zendesk', external_id: '7', priority: 11 },
    });
    await create({
      name: 'jira42',
      metadata: { source: 'jira', external_id: 42, priority: 'n/a' },
    });
    await create({ name: 'bare' });

    const finished = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${ids.zendesk7}/transitions`)
      .send({ transition: 'finish' });
    expect(finished.status).toBe(200);
  });

  test('finds a task by the record id the caller keeps in metadata', async () => {
    expect(
      await listIds({
        metadata: JSON.stringify({ source: 'zendesk', external_id: '42' }),
      })
    ).toEqual(idsOf('zendesk42'));
  });

  test('a number and its string spelling are different values', async () => {
    expect(
      await listIds({ metadata: JSON.stringify({ external_id: 42 }) })
    ).toEqual(idsOf('jira42'));
  });

  test('matches any of the listed values', async () => {
    expect(
      await listIds({
        metadata: JSON.stringify({ source: { in: ['jira', 'github'] } }),
      })
    ).toEqual(idsOf('jira42'));
  });

  test('orders a number numerically and leaves out another type', async () => {
    expect(
      await listIds({ metadata: JSON.stringify({ priority: { gte: 3 } }) })
    ).toEqual(idsOf('zendesk7'));
  });

  test('combines with the other filters', async () => {
    expect(
      await listIds({
        state: 'open',
        metadata: JSON.stringify({ source: 'zendesk' }),
      })
    ).toEqual(idsOf('zendesk42'));
  });

  test('an empty filter narrows nothing', async () => {
    expect(await listIds({ metadata: '{}' })).toEqual(
      idsOf('zendesk42', 'zendesk7', 'jira42', 'bare')
    );
  });

  test('narrows within the project asked for', async () => {
    const response = await list({
      project_id: otherProjectId,
      metadata: JSON.stringify({ source: 'zendesk' }),
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  test('refuses a filter that is not JSON', async () => {
    const response = await list({ metadata: '{source' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('refuses a non-orderable operand, naming the field', async () => {
    const response = await list({
      metadata: JSON.stringify({ priority: { gt: true } }),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.meta.field).toBe('priority');
  });

  test('requires authentication', async () => {
    const response = await testClient
      .get('/api/v1/tasks')
      .query({ metadata: JSON.stringify({ source: 'zendesk' }) });
    expect(response.status).toBe(401);
  });

  test('requires tasks:ListTasks', async () => {
    const response = await list(
      {
        project_id: projectId,
        metadata: JSON.stringify({ source: 'zendesk' }),
      },
      noPermToken
    );
    expect(response.status).toBe(403);
  });
});
