import { db } from 'src/db';
import { buildRunAuthHeader } from 'src/lib/orchestrationRunToken';
import { callTool } from 'src/lib/tools';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Pins the in-process dispatch path (#888): a `soat` tool reaches the platform
 * by running the app's own middleware stack against a synthetic request,
 * instead of making an HTTP request to `http://localhost:$PORT`.
 *
 * **The file's setup is the primary assertion.** It deliberately binds no
 * listener — unlike `soatSelfCall.test.ts` before #888, and unlike
 * `mcp.test.ts`, which still needs one. A self-call that goes back over the
 * wire has nothing to connect to here, so it fails with `ECONNREFUSED` rather
 * than passing quietly.
 *
 * Everything else in the file is about what must *not* change now that the
 * network hop is gone: the same permission evaluation, on the caller's live
 * policies, and the same error contract.
 */
describe('SOAT in-process dispatch', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let listToolsId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'soatinproc',
      policyActions: [
        'tools:CreateTool',
        'tools:ListTools',
        'tools:GetTool',
        'tools:CallTool',
        'tools:DeleteTool',
        'agents:GetAgent',
        'files:UploadFile',
        'files:GetFile',
        'files:DownloadFile',
        'workflows:CreateWorkflow',
        'workflows:GetWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:TransitionTask',
      ],
      createNoPermUser: false,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;
    policyId = setup.policyId;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-list-tools',
        type: 'soat',
        actions: ['list-tools'],
      });
    expect(toolRes.status).toBe(201);
    listToolsId = toolRes.body.id;
  });

  test('a soat action resolves with no HTTP listener bound', async () => {
    // Nothing is listening on the server's port in this file, so a loopback
    // self-call could not have produced this listing.
    const response = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${listToolsId}/call`)
      .send({ action: 'list-tools', input: {} });

    expect(response.status).toBe(200);
    const listing = response.body as { data?: { name?: string }[] };
    expect(Array.isArray(listing.data)).toBe(true);
    expect(
      listing.data!.some((entry) => {
        return entry.name === 'soat-inproc-list-tools';
      })
    ).toBe(true);
  });

  test('a soat action makes no outbound request', async () => {
    // The network boundary is not ours, so observing it is fair game — and it
    // is the only direct evidence that the hop is gone rather than merely
    // pointed somewhere else. `fetch` stays real: this asserts on calls, it
    // does not substitute behaviour.
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${listToolsId}/call`)
        .send({ action: 'list-tools', input: {} });

      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('a non-2xx self-call still fails the tool call with the target status', async () => {
    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-get-agent',
        type: 'soat',
        actions: ['get-agent'],
      });
    expect(toolRes.status).toBe(201);

    const response = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${toolRes.body.id}/call`)
      .send({
        action: 'get-agent',
        input: { agent_id: 'agent_nonexistent' },
      });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('TOOL_HTTP_ERROR');
    expect(response.body.error.meta.tool_status_code).toBe(404);
    expect(response.body.error.meta.tool_method).toBe('GET');
  });

  test('a 204 action returns an empty result instead of failing to parse one', async () => {
    const doomedRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-doomed-tool',
        type: 'soat',
        actions: ['list-tools'],
      });
    expect(doomedRes.status).toBe(201);

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-delete-tool',
        type: 'soat',
        actions: ['delete-tool'],
      });
    expect(toolRes.status).toBe(201);

    const response = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${toolRes.body.id}/call`)
      .send({
        action: 'delete-tool',
        input: { tool_id: doomedRes.body.id },
      });

    // A `204` carries no body to parse. Over the loopback that was read as a
    // failed JSON parse, so a delete that had already happened came back to the
    // caller as a failed tool call.
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();

    const deleted = await db.Tool.findOne({
      where: { publicId: doomedRes.body.id },
    });
    expect(deleted).toBeNull();
  });

  test('a streaming action is refused rather than answered with a mangled result', async () => {
    const uploadRes = await authenticatedTestClient(userToken)
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('not json at all'), {
        filename: 'inproc.txt',
        contentType: 'text/plain',
      })
      .field('project_id', projectId);
    expect(uploadRes.status).toBe(201);

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-download',
        type: 'soat',
        actions: ['download-file'],
      });
    expect(toolRes.status).toBe(201);

    const response = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${toolRes.body.id}/call`)
      .send({
        action: 'download-file',
        input: { file_id: uploadRes.body.id },
      });

    // Binary content has no JSON projection, and the alternative to refusing it
    // is a result built out of a stream's internals — plus the stream's own
    // file descriptor left open. Over the loopback this already failed, as an
    // opaque parse error after the bytes had crossed the wire.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('TOOL_CALL_NOT_SUPPORTED');
    expect(response.body.error.message).toMatch(/base64/);
  });

  test('permission is evaluated per call against the caller policies of the moment', async () => {
    const creatorRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-create-tool',
        type: 'soat',
        actions: ['create-tool'],
      });
    expect(creatorRes.status).toBe(201);

    const createInput = (name: string) => {
      return {
        action: 'create-tool',
        input: {
          project_id: projectId,
          name,
          type: 'soat',
          actions: ['list-tools'],
        },
      };
    };

    const allowed = await authenticatedTestClient(userToken)
      .post(`/api/v1/tools/${creatorRes.body.id}/call`)
      .send(createInput('soat-inproc-created-while-allowed'));
    expect(allowed.status).toBe(200);
    expect(allowed.body.name).toBe('soat-inproc-created-while-allowed');

    // Keeps `tools:CallTool` — so the outer route still authorizes — and drops
    // `tools:CreateTool`, which only the self-call needs. Without that split the
    // outer route would reject first and the self-call would never run.
    const narrowedRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['tools:CallTool'] }],
        },
      });
    expect(narrowedRes.status).toBe(201);

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [narrowedRes.body.id] });

    try {
      // The same token, the same tool, the same action — denied now, because
      // the self-call re-authorizes against the policies as they stand rather
      // than any snapshot taken when the tool was resolved.
      const denied = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${creatorRes.body.id}/call`)
        .send(createInput('soat-inproc-created-while-denied'));
      expect(denied.status).toBe(502);
      expect(denied.body.error.code).toBe('TOOL_HTTP_ERROR');
      expect(denied.body.error.meta.tool_status_code).toBe(403);

      const neverCreated = await db.Tool.findOne({
        where: { name: 'soat-inproc-created-while-denied' },
      });
      expect(neverCreated).toBeNull();
    } finally {
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyId] });
    }
  });

  test('a run-as token keeps its chain-hop marker across the in-process hop', async () => {
    const workflowRes = await authenticatedTestClient(userToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'soat-inproc-pingpong',
        states: [{ name: 'ping', initial: true }, { name: 'pong' }],
        transitions: [{ name: 'to_pong', from: ['ping'], to: 'pong' }],
      });
    expect(workflowRes.status).toBe(201);

    const taskRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({
        project_id: projectId,
        workflow_id: workflowRes.body.id,
        title: 'bounce',
      });
    expect(taskRes.status).toBe(201);

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-transition',
        type: 'soat',
        actions: ['transition-task'],
      });
    expect(toolRes.status).toBe(201);

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const authHeader = await buildRunAuthHeader({
      principalKind: 'user',
      principalId: userId,
      projectId: project!.id as number,
      workPublicId: taskRes.body.id,
    });
    expect(authHeader).toBeDefined();

    const result = await callTool({
      id: toolRes.body.id,
      action: 'transition-task',
      input: { task_id: taskRes.body.id, transition: 'to_pong' },
      authHeader,
    });

    // The budget that bounds a composed dispatch→transition cycle (#885) is
    // keyed on `ctx.authUser.isRunToken`, which only exists because the auth
    // middleware decoded the `orn` claim off this header. A dispatch seam that
    // passed a principal instead of a credential would skip that middleware,
    // this hop would count as a person's move (depth 0), the cycle would
    // silently become unbounded — and every #885 test would still pass, because
    // they all drive the HTTP route directly.
    expect(
      (result as { automation_chain_depth?: number }).automation_chain_depth
    ).toBe(1);
  });

  test('an unauthenticated self-call is refused, not served', async () => {
    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-inproc-unauth',
        type: 'soat',
        actions: ['list-tools'],
      });
    expect(toolRes.status).toBe(201);

    // No `authHeader`: the dispatch runs the real auth middleware, so an
    // uncredentialed self-call is rejected exactly as it was over the wire.
    // Sharing the process must never imply sharing the caller's authority.
    await expect(
      callTool({
        id: toolRes.body.id,
        action: 'list-tools',
        input: {},
      })
    ).rejects.toMatchObject({
      code: 'TOOL_HTTP_ERROR',
      meta: { tool_status_code: 401 },
    });
  });
});
