import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { offeredSchema } from '../../fixtures/scriptedModel';

/**
 * A `builtin` tool's `preset_parameters_by_action` overrides its
 * `preset_parameters` per action, key by key, and every action's effective
 * preset must be declared by that action's schema.
 */
describe('builtin preset_parameters_by_action', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'presetsbyaction' });
  });

  afterAll(async () => {
    await turn.close();
  });

  const builtinTool = (extra: Record<string, unknown>) => {
    return turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      ...extra,
    });
  };

  const postTool = (extra: Record<string, unknown>) => {
    return turn
      .api()
      .post('/api/v1/tools')
      .send({
        project_id: turn.projectId,
        name: turn.unique('builtin'),
        type: 'builtin',
        ...extra,
      });
  };

  const bindAgent = (toolId: string) => {
    return turn.createAgent({ tool_bindings: [{ tool_id: toolId }] });
  };

  describe('dispatch', () => {
    test('an action takes its own key over the tool key and inherits the rest', async () => {
      const target = await builtinTool({ actions: ['list-files'] });
      const decoy = await builtinTool({ actions: ['list-files'] });
      const pinned = await builtinTool({
        actions: ['update-tool'],
        preset_parameters: { tool_id: decoy.id, description: 'pinned' },
        preset_parameters_by_action: {
          'update-tool': { tool_id: target.id },
        },
      });

      const res = await turn
        .api()
        .post(`/api/v1/tools/${pinned.id}/call`)
        .send({ action: 'update-tool', input: {} });

      expect(res.status).toBe(200);
      const read = async (id: string) => {
        return (await turn.api().get(`/api/v1/tools/${id}`)).body;
      };
      expect((await read(target.id)).description).toBe('pinned');
      expect((await read(decoy.id)).description).toBeNull();
    });

    test('an agent action is sent its effective preset over the model value', async () => {
      const target = await builtinTool({ actions: ['list-files'] });
      const decoy = await builtinTool({ actions: ['list-files'] });
      const pinned = await builtinTool({
        actions: ['get-tool', 'update-tool'],
        preset_parameters: { tool_id: decoy.id },
        preset_parameters_by_action: { 'get-tool': { tool_id: target.id } },
      });
      const agentId = await bindAgent(pinned.id);

      const { results } = await turn.generate({
        agentId,
        calls: [
          { name: `${pinned.name}_get-tool`, args: { tool_id: decoy.id } },
        ],
      });

      expect(results[0]).toMatchObject({ id: target.id });
    });

    test("each action's schema hides only that action's effective keys", async () => {
      const target = await builtinTool({ actions: ['list-files'] });
      const pinned = await builtinTool({
        actions: ['get-tool', 'update-tool'],
        preset_parameters_by_action: {
          'update-tool': { tool_id: target.id },
        },
      });
      const agentId = await bindAgent(pinned.id);

      await turn.generate({ agentId, calls: [] });

      const properties = (action: string) => {
        return offeredSchema({
          model: turn.model,
          toolName: `${pinned.name}_${action}`,
        })?.properties;
      };
      expect(properties('get-tool')).toHaveProperty('tool_id');
      expect(properties('update-tool')).not.toHaveProperty('tool_id');
    });
  });

  describe('write', () => {
    test('round-trips on read', async () => {
      const target = await builtinTool({ actions: ['list-files'] });
      const created = await builtinTool({
        actions: ['get-tool'],
        preset_parameters_by_action: { 'get-tool': { tool_id: target.id } },
      });

      const res = await turn.api().get(`/api/v1/tools/${created.id}`);

      expect(res.body.preset_parameters_by_action).toEqual({
        'get-tool': { tool_id: target.id },
      });
    });

    test('refuses a tool preset an action does not declare', async () => {
      const res = await postTool({
        actions: ['get-tool', 'list-tools'],
        preset_parameters: { tool_id: 'tool_x' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({
          code: 'UNDECLARED_PRESET_PARAMETER',
          path: 'preset_parameters.tool_id',
          message: expect.stringContaining('list-tools'),
        }),
      ]);
    });

    test('refuses an action preset its action does not declare', async () => {
      const res = await postTool({
        actions: ['get-tool'],
        preset_parameters_by_action: { 'get-tool': { limit: 1 } },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({
          path: 'preset_parameters_by_action.get-tool.limit',
        }),
      ]);
    });

    test('refuses an entry for an action the tool does not list', async () => {
      const res = await postTool({
        actions: ['get-tool'],
        preset_parameters_by_action: { 'list-tools': { limit: 1 } },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({
          code: 'UNKNOWN_ACTION',
          path: 'preset_parameters_by_action.list-tools',
        }),
      ]);
    });

    test('refuses an entry that is not an object', async () => {
      const res = await postTool({
        actions: ['get-tool'],
        preset_parameters_by_action: { 'get-tool': 'tool_x' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses per-action presets on a tool that is not builtin', async () => {
      const res = await turn
        .api()
        .post('/api/v1/tools')
        .send({
          project_id: turn.projectId,
          name: turn.unique('http'),
          type: 'http',
          execute: { url: `${turn.target.baseUrl}/x`, method: 'POST' },
          preset_parameters_by_action: { 'get-tool': { tool_id: 'tool_x' } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({ path: 'preset_parameters_by_action' }),
      ]);
    });

    test('does not hold a denied action to the tool presets', async () => {
      const res = await postTool({
        actions: ['get-tool', 'list-tools'],
        denied_actions: ['list-tools'],
        preset_parameters: { tool_id: 'tool_x' },
      });

      expect(res.status).toBe(201);
    });

    test('takes a tool-level `action`, which selects the action of a direct call', async () => {
      const res = await postTool({
        actions: ['list-tools'],
        preset_parameters: { action: 'list-tools' },
      });

      expect(res.status).toBe(201);
    });

    test('refuses an update whose new action does not declare a stored preset', async () => {
      const created = await builtinTool({
        actions: ['get-tool'],
        preset_parameters: { tool_id: 'tool_x' },
      });

      const res = await turn
        .api()
        .patch(`/api/v1/tools/${created.id}`)
        .send({ actions: ['get-tool', 'list-tools'] });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({ path: 'preset_parameters.tool_id' }),
      ]);
    });
  });

  describe('formations', () => {
    const template = (byAction: object) => {
      return {
        resources: {
          Pinned: {
            type: 'tool',
            properties: {
              name: turn.unique('fmbuiltin'),
              type: 'builtin',
              actions: ['get-tool', 'update-tool'],
              preset_parameters_by_action: byAction,
            },
          },
        },
      };
    };

    test('validate reports an action preset its action does not declare', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations/validate')
        .send({ template: template({ 'get-tool': { limit: 1 } }) });

      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          path: 'resources.Pinned.properties.preset_parameters_by_action.get-tool.limit',
        }),
      ]);
    });

    test('validate reports an entry that is not an object', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations/validate')
        .send({ template: template({ 'get-tool': 'tool_x' }) });

      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          path: 'resources.Pinned.properties.preset_parameters_by_action.get-tool',
        }),
      ]);
    });

    test('an apply stores the per-action presets', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations')
        .send({
          project_id: turn.projectId,
          name: turn.unique('fmpresets'),
          template: template({ 'update-tool': { tool_id: 'tool_x' } }),
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      const toolId = res.body.resources.find(
        (resource: { logical_id: string }) => {
          return resource.logical_id === 'Pinned';
        }
      ).physical_resource_id;
      const tool = await turn.api().get(`/api/v1/tools/${toolId}`);
      expect(tool.body.preset_parameters_by_action).toEqual({
        'update-tool': { tool_id: 'tool_x' },
      });
    });
  });
});
