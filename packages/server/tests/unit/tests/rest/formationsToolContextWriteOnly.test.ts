import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A Trigger's `tool_context` is write-only: `findTrigger` never returns it
 * (`toolContextCarrier.ts`), so `plan-formation`'s live-read diff can never
 * confirm a declared literal still matches. `triggersFormationModule`'s
 * `writeOnlyProperties: ['tool_context']` is what keeps `applyUpdateChange`
 * from persisting the raw value into `lastAppliedProperties` to make its own
 * diff agree with a live read that plan already never gets — a plan and the
 * apply it previews reporting different actions for the same unchanged
 * template is the defect this pins closed.
 */
describe('Formations: tool_context is write-only on a Trigger', () => {
  let userToken: string;
  let projectId: string;
  let agentId: string;
  let triggerFormationId: string;

  const templateFor = (note: string) => {
    return {
      resources: {
        MyTrigger: {
          type: 'trigger',
          properties: {
            name: 'formation-tool-context-trigger',
            type: 'manual',
            target_type: 'agent',
            target_id: agentId,
            tool_context: { note },
          },
        },
      },
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fmtcwo',
      policyActions: [
        'formations:CreateFormation',
        'formations:PlanFormation',
        'formations:UpdateFormation',
        'formations:GetFormation',
        'formations:ListFormationEvents',
        'agents:CreateAgent',
        'ai-providers:CreateAiProvider',
        'triggers:CreateTrigger',
        'triggers:UpdateTrigger',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const aiProviderRes = await authenticatedTestClient(userToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `fmtcwo-provider-${Date.now()}`,
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(aiProviderRes.status).toBe(201);

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: `fmtcwo-agent-${Date.now()}`,
        ai_provider_id: aiProviderRes.body.id,
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  test('creating the formation applies a literal tool_context', async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: `fmtcwo-formation-${Date.now()}`,
        template: templateFor('v1'),
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    triggerFormationId = res.body.id;
  });

  test('plan-formation reports update for the unchanged literal, not no-op', async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations/plan')
      .send({
        project_id: projectId,
        formation_id: triggerFormationId,
        template: templateFor('v1'),
      });

    expect(res.status).toBe(200);
    const triggerChange = res.body.changes.find((c: { logical_id: string }) => {
      return c.logical_id === 'MyTrigger';
    });
    expect(triggerChange).toBeDefined();
    expect(triggerChange.action).toBe('update');
    expect(triggerChange.diff.current).not.toHaveProperty('tool_context');
  });

  test('re-applying the unchanged literal still performs an update, not a no-op', async () => {
    const res = await authenticatedTestClient(userToken)
      .put(`/api/v1/formations/${triggerFormationId}`)
      .send({ template: templateFor('v1') });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');

    const eventsRes = await authenticatedTestClient(userToken).get(
      `/api/v1/formations/${triggerFormationId}/events`
    );
    expect(eventsRes.status).toBe(200);
    const updateOp = eventsRes.body.data.find(
      (op: { operation_type: string }) => {
        return op.operation_type === 'update';
      }
    );
    expect(updateOp).toBeDefined();
    const triggerEvent = updateOp.events.find((e: { logical_id: string }) => {
      return e.logical_id === 'MyTrigger';
    });
    expect(triggerEvent.action).toBe('update');
  });
});
