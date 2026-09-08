import type { Tool } from 'ai';
import { resolveSoatTools } from 'src/lib/agentToolResolverExternalTools';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * A builtin action runs under the caller's bearer with an LLM choosing the
 * arguments, so `project_id` decides which project the generation acts on. A
 * bearer that spans two projects is ordinary — a user is usually a member of
 * several — and without a pin the model picks between them.
 *
 * Executed against the real in-process dispatch rather than a stub: the pin has
 * to survive the whole path from the resolved tool to the route that answers,
 * which is where a merge order or a builder that reads the wrong key would
 * show up.
 */
describe('a builtin tool acts on the generation\'s project', () => {
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;
  let agentInProject: string;
  let agentInOtherProject: string;

  const resolveListAgents = (projectPublicId?: string): Tool => {
    const tools = resolveSoatTools({
      typedTool: {
        name: 'platform',
        description: null,
        actions: ['list-agents'],
      },
      authHeader: `Bearer ${adminToken}`,
      projectPublicId,
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: () => {},
    });
    return tools['platform_list-agents'];
  };

  const listedAgentIds = async (input: Record<string, unknown>, tool: Tool) => {
    const result = (await tool.execute?.(input, {
      messages: [],
      toolCallId: 'call_1',
      context: undefined,
    })) as { data?: Array<{ id: string }> };
    return (result.data ?? []).map((agent) => {
      return agent.id;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'pinproj',
      policyActions: ['agents:ListAgents', 'agents:CreateAgent'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    await loginAs('pinprojadmin', 'supersecret');

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Pin Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const otherProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectId,
        name: 'Pin Other Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const own = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'In Project',
        ai_provider_id: provider.body.id,
      });
    agentInProject = own.body.id;

    const other = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: otherProjectId,
        name: 'In Other Project',
        ai_provider_id: otherProvider.body.id,
      });
    agentInOtherProject = other.body.id;
  });

  test('the model cannot choose another project', async () => {
    const listed = await listedAgentIds(
      { project_id: otherProjectId },
      resolveListAgents(projectId)
    );

    expect(listed).toContain(agentInProject);
    expect(listed).not.toContain(agentInOtherProject);
  });

  test('omitting it reaches the generation\'s project all the same', async () => {
    const listed = await listedAgentIds({}, resolveListAgents(projectId));

    expect(listed).toContain(agentInProject);
    expect(listed).not.toContain(agentInOtherProject);
  });

  // Nothing for the model to guess at, and nothing for it to waste a token on.
  test('project_id is not in the schema the model sees', () => {
    const schema = resolveListAgents(projectId).inputSchema as {
      jsonSchema?: { properties?: Record<string, unknown> };
    };
    expect(schema.jsonSchema?.properties ?? {}).not.toHaveProperty(
      'project_id'
    );
  });

  // The pin outranks the tool row's own preset: an operator pinning another
  // project would otherwise reintroduce exactly what this closes.
  test('a preset naming another project does not move the call', async () => {
    const tools = resolveSoatTools({
      typedTool: {
        name: 'platform',
        description: null,
        actions: ['list-agents'],
        presetParameters: { project_id: otherProjectId },
      },
      authHeader: `Bearer ${adminToken}`,
      projectPublicId: projectId,
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: () => {},
    });

    const listed = await listedAgentIds({}, tools['platform_list-agents']);
    expect(listed).toContain(agentInProject);
    expect(listed).not.toContain(agentInOtherProject);
  });

  // Only the agent surface is pinned. A caller reaching the same action
  // without a generation is acting as themselves, exactly as they would by
  // calling the route.
  test('no generation project leaves the call as the caller wrote it', async () => {
    const listed = await listedAgentIds(
      { project_id: otherProjectId },
      resolveListAgents(undefined)
    );

    expect(listed).toContain(agentInOtherProject);
  });
});
