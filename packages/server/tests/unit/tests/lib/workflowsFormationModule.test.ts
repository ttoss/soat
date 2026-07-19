import { db } from 'src/db';
import { workflowsFormationModule } from 'src/lib/formation-modules/workflowsFormationModule';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('workflowsFormationModule', () => {
  let adminToken: string;
  let projectId: string;
  let projectDbId: number;
  let agentId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'wfformadmin', password: 'supersecret' });
    adminToken = await loginAs('wfformadmin', 'supersecret');
    const admin = authenticatedTestClient(adminToken);

    const projectRes = await admin
      .post('/api/v1/projects')
      .send({ name: 'Workflow Formation Module Project' });
    projectId = projectRes.body.id;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectDbId = project?.id as number;

    const providerRes = await admin.post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'WFFormProvider',
      provider: 'openai',
      default_model: 'gpt-4o',
    });

    const agentRes = await admin.post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'WF Form Agent',
    });
    agentId = agentRes.body.id;
  });

  test('validateProperties rejects a non-object and a missing required field', () => {
    expect(
      workflowsFormationModule.validateProperties!({
        properties: 'nope',
        basePath: 'x',
      }).length
    ).toBeGreaterThan(0);
    // `states`/`transitions` are required — a name-only bag is incomplete.
    expect(
      workflowsFormationModule.validateProperties!({
        properties: { name: 'x' },
        basePath: 'x',
      }).length
    ).toBeGreaterThan(0);
  });

  test('validateProperties rejects an unknown field', () => {
    const errors = workflowsFormationModule.validateProperties!({
      properties: {
        name: 'wf',
        states: [{ name: 'a', initial: true }],
        transitions: [],
        bogus: true,
      },
      basePath: 'x',
    });
    expect(
      errors.some((e) => {
        return e.message.includes('bogus');
      })
    ).toBe(true);
  });

  test('create resolves nested on_enter dispatch + guard, then read/update/delete', async () => {
    const created = await workflowsFormationModule.create!({
      projectId: projectDbId,
      properties: {
        name: 'Module workflow',
        description: 'via module',
        states: [
          { name: 'todo', initial: true, kind: 'human', stalled_after: 60 },
          {
            name: 'working',
            on_enter: {
              dispatch: { kind: 'agent', agent_id: agentId },
              on_complete: [
                {
                  when: { '==': [{ var: 'result.ok' }, true] },
                  transition: 'finish',
                },
              ],
            },
          },
          { name: 'done', terminal: true },
        ],
        transitions: [
          { name: 'start', from: ['todo'], to: 'working' },
          {
            name: 'finish',
            from: ['working'],
            to: 'done',
            guard: { '==': [{ var: 'task.payload.approved' }, true] },
          },
        ],
        payload_schema: {
          type: 'object',
          properties: { approved: { type: 'boolean' } },
        },
      },
    });
    expect(created).toMatch(/^wfl_/);

    const read = await workflowsFormationModule.read!({
      physicalResourceId: created,
    });
    expect(read?.name).toBe('Module workflow');
    // The nested state keys round-trip back to snake_case.
    const states = read?.states as Array<Record<string, unknown>>;
    const working = states.find((s) => {
      return s.name === 'working';
    })!;
    const onEnter = working.on_enter as Record<string, unknown>;
    const dispatch = onEnter.dispatch as Record<string, unknown>;
    expect(dispatch.agent_id).toBe(agentId);
    // The JSON-Logic guard body round-trips verbatim (inner `var` untouched).
    const transitions = read?.transitions as Array<Record<string, unknown>>;
    const finish = transitions.find((t) => {
      return t.name === 'finish';
    })!;
    expect(finish.guard).toEqual({
      '==': [{ var: 'task.payload.approved' }, true],
    });

    await workflowsFormationModule.update!({
      physicalResourceId: created,
      properties: {
        name: 'Module workflow v2',
        states: [{ name: 'solo', initial: true }],
        transitions: [],
      },
    });
    const readAfter = await workflowsFormationModule.read!({
      physicalResourceId: created,
    });
    expect(readAfter?.name).toBe('Module workflow v2');
    expect(readAfter?.states).toEqual([{ name: 'solo', initial: true }]);

    await workflowsFormationModule.delete!({ physicalResourceId: created });
    const readGone = await workflowsFormationModule.read!({
      physicalResourceId: created,
    });
    expect(readGone).toBeNull();
  });

  test('read returns null for a missing workflow (drift)', async () => {
    const read = await workflowsFormationModule.read!({
      physicalResourceId: 'wfl_missing',
    });
    expect(read).toBeNull();
  });

  test('create throws on an invalid definition (two initial states)', async () => {
    await expect(
      workflowsFormationModule.create!({
        projectId: projectDbId,
        properties: {
          name: 'bad workflow',
          states: [
            { name: 'a', initial: true },
            { name: 'b', initial: true },
          ],
          transitions: [],
        },
      })
    ).rejects.toThrow();
  });
});
