import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('PATCH /tasks/{task_id} metadata', () => {
  let userToken: string;
  let readOnlyToken: string;
  let projectId: string;
  let workflowId: string;

  const patch = (
    id: string,
    body: Record<string, unknown>,
    token = userToken
  ) => {
    return authenticatedTestClient(token)
      .patch(`/api/v1/tasks/${id}`)
      .send(body);
  };

  const create = async (metadata?: Record<string, unknown>) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({
        project_id: projectId,
        workflow_id: workflowId,
        title: 'Labelled',
        payload: { kept: true },
        metadata,
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taskmetaupdate',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:ListTasks',
        'tasks:UpdateTask',
        'tasks:TransitionTask',
      ],
      createNoPermUser: true,
    });
    userToken = setup.userToken;
    readOnlyToken = setup.noPermToken!;
    projectId = setup.projectId;

    const workflow = await authenticatedTestClient(userToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'task-metadata-update',
        states: [
          { name: 'open', initial: true },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
      });
    expect(workflow.status).toBe(201);
    workflowId = workflow.body.id;
  });

  test('replaces the stored bag and leaves the payload alone', async () => {
    const id = await create({ source: 'import', tags: 'a' });
    const response = await patch(id, { metadata: { tags: 'b', revision: 2 } });
    expect(response.status).toBe(200);
    expect(response.body.metadata).toEqual({ tags: 'b', revision: 2 });
    expect(response.body.payload).toEqual({ kept: true });

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${id}`
    );
    expect(read.body.metadata).toEqual({ tags: 'b', revision: 2 });
  });

  test('sets a bag on a task created without one', async () => {
    const id = await create();
    const response = await patch(id, { metadata: { label: 'x' } });
    expect(response.status).toBe(200);
    expect(response.body.metadata).toEqual({ label: 'x' });
  });

  test('null clears the bag', async () => {
    const id = await create({ label: 'x' });
    const response = await patch(id, { metadata: null });
    expect(response.status).toBe(200);
    expect(response.body.metadata).toBeUndefined();
  });

  test('an update without metadata keeps it', async () => {
    const id = await create({ label: 'x' });
    const response = await patch(id, { title: 'Renamed' });
    expect(response.status).toBe(200);
    expect(response.body.metadata).toEqual({ label: 'x' });
  });

  test('the list filter reads the updated bag', async () => {
    const id = await create({ stage: 'one' });
    await patch(id, { metadata: { stage: 'two' } });
    const listed = await authenticatedTestClient(userToken)
      .get('/api/v1/tasks')
      .query({ workflow_id: workflowId, metadata: '{"stage":"two"}' });
    expect(
      listed.body.data.map((task: { id: string }) => {
        return task.id;
      })
    ).toEqual([id]);
  });

  test('a terminal task still takes new metadata', async () => {
    const id = await create({ label: 'x' });
    await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${id}/transitions`)
      .send({ transition: 'finish' });
    const response = await patch(id, { metadata: { label: 'y' } });
    expect(response.status).toBe(200);
    expect(response.body.metadata).toEqual({ label: 'y' });
  });

  test.each([
    ['a string', 'x'],
    ['an array', ['x']],
    ['a number', 3],
  ])('%s is 400 and the stored bag is kept', async (_name, metadata) => {
    const id = await create({ label: 'x' });
    const response = await patch(id, { metadata });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${id}`
    );
    expect(read.body.metadata).toEqual({ label: 'x' });
  });

  test('401 without a token', async () => {
    const id = await create();
    const response = await testClient
      .patch(`/api/v1/tasks/${id}`)
      .send({ metadata: { a: 1 } });
    expect(response.status).toBe(401);
  });

  test('403 without tasks:UpdateTask', async () => {
    const id = await create({ label: 'x' });
    const response = await patch(id, { metadata: { a: 1 } }, readOnlyToken);
    expect(response.status).toBe(403);
  });
});
