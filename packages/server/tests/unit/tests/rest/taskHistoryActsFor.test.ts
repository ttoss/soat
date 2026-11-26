import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

type HistoryRow = {
  transition: string | null;
  principal_type: string;
  principal_id: string | null;
  acts_for: { type: string; id: string } | null;
};

/**
 * A task's history names the principal an IAM token acts for beside the key
 * that minted it, whether the token moves the task directly or through a
 * `builtin` tool's `transition-task`.
 */
describe('GET /api/v1/tasks/:task_id/history acts_for', () => {
  let adminToken: string;
  let projectId: string;
  let workflowId: string;
  let key: string;
  let keyId: string;
  let toolId: string;

  const mintToken = async (principal: { type: string; id: string }) => {
    const res = await authenticatedTestClient(key)
      .post('/api/v1/iam/tokens')
      .send({
        policy: { statement: [{ effect: 'Allow', action: ['*'] }] },
        principal,
      });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const createTask = async (credential: string): Promise<string> => {
    const res = await authenticatedTestClient(credential)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const fire = async (args: { credential: string; taskId: string }) => {
    const res = await authenticatedTestClient(args.credential)
      .post(`/api/v1/tasks/${args.taskId}/transitions`)
      .send({ transition: 'flip' });
    expect(res.status).toBe(200);
  };

  const fireThroughTool = async (args: {
    credential: string;
    taskId: string;
  }) => {
    const res = await authenticatedTestClient(args.credential)
      .post(`/api/v1/tools/${toolId}/call`)
      .send({
        action: 'transition-task',
        input: { task_id: args.taskId, transition: 'flip' },
      });
    expect(res.status).toBe(200);
  };

  const history = async (taskId: string): Promise<HistoryRow[]> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/tasks/${taskId}/history`
    );
    expect(res.status).toBe(200);
    return res.body.data as HistoryRow[];
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taskactsfor',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'mcp server deputy', project_id: projectId });
    expect(keyRes.status).toBe(201);
    key = keyRes.body.key;
    keyId = keyRes.body.id;

    const workflow = await authenticatedTestClient(adminToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'acts-for',
        states: [{ name: 'a', initial: true }, { name: 'b' }],
        transitions: [{ name: 'flip', from: ['a', 'b'], to: 'b' }],
      });
    expect(workflow.status).toBe(201);
    workflowId = workflow.body.id;

    const tool = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'move-task',
        type: 'builtin',
        actions: ['transition-task'],
      });
    expect(tool.status).toBe(201);
    toolId = tool.body.id;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  test('a move on an IAM token names the token principal beside the minting key', async () => {
    const taskId = await createTask(key);
    const token = await mintToken({ type: 'mcp_key', id: 'deputy-1' });
    await fire({ credential: token, taskId });

    const moved = (await history(taskId)).at(-1);
    expect(moved).toMatchObject({
      transition: 'flip',
      principal_type: 'api_key',
      principal_id: keyId,
      acts_for: { type: 'mcp_key', id: 'deputy-1' },
    });
  });

  test('two tokens of one key moving through a builtin tool read back two principals', async () => {
    const taskId = await createTask(key);
    await fireThroughTool({
      credential: await mintToken({ type: 'mcp_key', id: 'deputy-1' }),
      taskId,
    });
    await fireThroughTool({
      credential: await mintToken({ type: 'mcp_account', id: 'member-2' }),
      taskId,
    });

    const moves = (await history(taskId)).filter((row) => {
      return row.transition === 'flip';
    });
    expect(
      moves.map((row) => {
        return row.acts_for;
      })
    ).toEqual([
      { type: 'mcp_key', id: 'deputy-1' },
      { type: 'mcp_account', id: 'member-2' },
    ]);
  });

  test('the placement row of a task created on a token names its principal', async () => {
    const taskId = await createTask(
      await mintToken({ type: 'mcp_key', id: 'creator' })
    );
    expect((await history(taskId))[0]?.acts_for).toEqual({
      type: 'mcp_key',
      id: 'creator',
    });
  });

  test('a move on the key itself acts for nobody', async () => {
    const taskId = await createTask(key);
    await fire({ credential: key, taskId });

    expect(
      (await history(taskId)).map((row) => {
        return row.acts_for;
      })
    ).toEqual([null, null]);
  });
});
