import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A `builtin` tool bound to `call-tool` calls another tool, and that target's
 * `action` is an input of `call-tool`, not the outer tool's action.
 */
describe('a builtin call-tool whose target is a builtin tool', () => {
  let adminToken: string;
  let projectId: string;
  let targetId: string;
  let outerId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'calltooltarget',
      policyActions: ['tools:CreateTool', 'tools:ListTools', 'tools:CallTool'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const target = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'call-tool-target',
        type: 'builtin',
        actions: ['list-tools'],
      });
    expect(target.status).toBe(201);
    targetId = target.body.id;

    const outer = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'call-tool-outer',
        type: 'builtin',
        actions: ['call-tool'],
        preset_parameters: { tool_id: targetId },
      });
    expect(outer.status).toBe(201);
    outerId = outer.body.id;
  });

  test('the target runs its own action', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${outerId}/call`)
      .send({
        action: 'call-tool',
        input: { action: 'list-tools', input: { project_id: projectId } },
      });
    expect(response.status).toBe(200);
    const names = (response.body.data as { name: string }[]).map((tool) => {
      return tool.name;
    });
    expect(names).toEqual(
      expect.arrayContaining(['call-tool-target', 'call-tool-outer'])
    );
  });

  test("an outer action never consumes the target's", async () => {
    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${outerId}/call`)
      .send({ action: 'call-tool', input: { action: 'delete-tool' } });
    expect(response.status).not.toBe(200);
    expect(JSON.stringify(response.body)).toMatch(
      /delete-tool.{0,8} is not available on this tool/
    );
  });

  test('without an outer action the input names it', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${outerId}/call`)
      .send({ input: { action: 'call-tool' } });
    expect(JSON.stringify(response.body)).toMatch(
      /`action` is required for builtin tools/
    );
  });
});
