import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Tools authorize per tool, not per project: a policy naming one tool's SRN
 * reaches that tool and refuses its siblings, on every route that acts on one.
 *
 * `tools:CallTool` is why this is the module the audit put first — the route
 * *executes*. `approvals.ts` already checks `CallTool` against the tool's own
 * SRN, so before this a per-tool policy was honored on the approval path and
 * ignored on the direct route: the same grant answered two different questions
 * depending on which door the call came through (#1339).
 */
describe('a policy scoped to one tool does not reach another', () => {
  let adminToken: string;
  let projectId: string;
  let scopedToken: string;
  let noPermToken: string;
  let allowedToolId: string;
  let otherToolId: string;

  const TOOL_ACTIONS = [
    'tools:GetTool',
    'tools:UpdateTool',
    'tools:DeleteTool',
    'tools:CallTool',
    'tools:ListTools',
  ];

  const createTool = async (name: string): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name,
        type: 'client',
        description: 'A client-side dialog tool',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      });
    return response.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'toolscope',
      policyActions: TOOL_ACTIONS,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;

    allowedToolId = await createTool('scoped-tool');
    otherToolId = await createTool('other-tool');

    // A user whose only grant names one tool, so every refusal below is the
    // resource check rather than a missing action.
    const scopedUser = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'toolscopescoped', password: 'toolScopePass1' });
    const scopedPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: TOOL_ACTIONS,
              resource: [`srn:${projectId}:tool:${allowedToolId}`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${scopedUser.body.id}/policies`)
      .send({ policy_ids: [scopedPolicy.body.id] });
    scopedToken = await loginAs('toolscopescoped', 'toolScopePass1');
  });

  describe('GET /api/v1/tools/:tool_id', () => {
    test('reaches the tool the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/tools/${allowedToolId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedToolId);
    });

    // A read the caller may not perform is indistinguishable from absence —
    // the shape this route already answered for a cross-project read.
    test('hides a sibling tool in the same project', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/tools/${otherToolId}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/tools/:tool_id', () => {
    test('refuses a sibling tool', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/tools/${otherToolId}`)
        .send({ description: 'Rewritten by a caller I may not touch.' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the tool the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/tools/${allowedToolId}`)
        .send({ description: 'Scoped rewrite.' });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Scoped rewrite.');
    });
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('refuses a sibling tool', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/tools/${otherToolId}/call`)
        .send({});

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    // 422 is what a client tool answers once the call is authorized: the
    // refusal is gone and execution was reached.
    test('reaches the tool the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/tools/${allowedToolId}/call`)
        .send({});

      expect(response.status).toBe(422);
    });
  });

  describe('GET /api/v1/tools', () => {
    // The listing is project-scoped for every module: it probes the caller's
    // policy with `srn:<project>:tool:*`, which a statement naming one tool
    // cannot match. Narrowing a listing by resource is a shared-IAM change,
    // so it is deliberately not this one (#1336).
    test('a policy scoped to one tool cannot list tools', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/tools?project_id=${projectId}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  /**
   * The two halves of a write refusal, side by side.
   *
   * A sibling in a project the caller *does* reach is `403`: they can see the
   * project, so being told plainly that this tool is off limits tells them
   * nothing they could not already work out (#1029). A tool in a project they
   * reach not at all is `404`: there, a `403` would confirm its existence to
   * someone with no business knowing it exists.
   */
  describe('a caller whose projects do not include the tool at all', () => {
    let outsiderToken: string;
    let insideToolId: string;

    beforeAll(async () => {
      const otherProject = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Tool Scope Other Project' });

      const outsider = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'toolscopeoutsider', password: 'toolScopePass2' });
      const policy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: TOOL_ACTIONS,
                resource: [`srn:${otherProject.body.id}:*:*`],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${outsider.body.id}/policies`)
        .send({ policy_ids: [policy.body.id] });
      outsiderToken = await loginAs('toolscopeoutsider', 'toolScopePass2');

      insideToolId = await createTool('outsider-target-tool');
    });

    test('hides the tool on a write, where a sibling in reach is refused', async () => {
      const response = await authenticatedTestClient(outsiderToken)
        .patch(`/api/v1/tools/${insideToolId}`)
        .send({ description: 'Reached across a tenant boundary.' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('hides the tool on a call', async () => {
      const response = await authenticatedTestClient(outsiderToken)
        .post(`/api/v1/tools/${insideToolId}/call`)
        .send({});

      expect(response.status).toBe(404);
    });

    test('hides the tool on a read, as it always did', async () => {
      const response = await authenticatedTestClient(outsiderToken).get(
        `/api/v1/tools/${insideToolId}`
      );

      expect(response.status).toBe(404);
    });
  });

  /**
   * A caller whose policies name no project at all is the far side of every
   * tenant boundary, not the near side of none: nothing they hold concerns the
   * project this tool is in, so a `403` would confirm it exists to the least
   * privileged caller there is.
   */
  describe('a caller with no grants at all', () => {
    test('hides the tool on a write', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/tools/${allowedToolId}`)
        .send({ description: 'Reached with no grants whatsoever.' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    // The same answer a made-up id gets, which is the point: the two are no
    // longer distinguishable.
    test('answers a made-up id identically', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch('/api/v1/tools/tool_doesnotexist000')
        .send({ description: 'Reached with no grants whatsoever.' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('DELETE /api/v1/tools/:tool_id', () => {
    test('refuses a sibling tool', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/tools/${otherToolId}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the tool the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/tools/${allowedToolId}`
      );

      expect(response.status).toBe(204);
    });
  });
});
