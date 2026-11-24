import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// Every trigger field validated by the shape rule may hold a `ref`, `param`
// or `sub`; the template validates, and the apply stores the resolved value.

let adminToken: string;
let projectId: string;
let policyId: string;
let aiProviderId: string;
let agentId: string;

const client = () => {
  return authenticatedTestClient(adminToken);
};

const eventTrigger = (fields: Record<string, unknown>) => {
  return {
    parameters: { Value: { type: 'string' } },
    resources: {
      Target: {
        type: 'agent',
        properties: { ai_provider_id: aiProviderId, name: 'Target' },
      },
      Res: {
        type: 'trigger',
        properties: {
          policy_ids: [policyId],
          name: 'Resolved',
          type: 'event',
          target_type: 'agent',
          target_id: agentId,
          events: ['agents.*'],
          ...fields,
        },
      },
    },
  };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmtrigexpr',
    // The trigger's policy must read the events it subscribes to.
    policyActions: ['formations:GetFormation', 'agents:GetAgent'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
  policyId = setup.policyId;

  const providerRes = await client().post('/api/v1/ai-providers').send({
    project_id: projectId,
    name: 'Expr Provider',
    provider: 'openai',
    default_model: 'gpt-4o',
  });
  aiProviderId = providerRes.body.id;

  const agentRes = await client().post('/api/v1/agents').send({
    project_id: projectId,
    ai_provider_id: aiProviderId,
    name: 'Expr Agent',
  });
  agentId = agentRes.body.id;
});

describe('POST /api/v1/formations/validate — a trigger field from an expression', () => {
  const EXPRESSIONS: [string, Record<string, unknown>][] = [
    ['an event_data value', { event_data: { agent_id: { ref: 'Target' } } }],
    [
      'an event_data in item',
      { event_data: { agent_id: { in: [{ ref: 'Target' }] } } },
    ],
    [
      'an event_data bound',
      { event_data: { name: { gte: { param: 'Value' } } } },
    ],
    ['the whole event_data', { event_data: { param: 'Value' } }],
    ['an event_resources item', { event_resources: [{ param: 'Value' }] }],
    ['an events item', { events: [{ param: 'Value' }] }],
    ['the events list', { events: { param: 'Value' } }],
  ];

  test.each(EXPRESSIONS)('%s validates', async (_name, fields) => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({ template: eventTrigger(fields) });

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.valid).toBe(true);
  });

  test('a literal event_data beside an expression is still checked', async () => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({
        template: eventTrigger({
          event_resources: [{ param: 'Value' }],
          event_data: { name: { near: 'x' } },
        }),
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors[0].message).toMatch(/'near' is not an operator/);
  });
});

describe('POST /api/v1/formations — a trigger event_data ref', () => {
  test('stores the referenced resource id', async () => {
    const res = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'trigger-event-data-ref',
        template: eventTrigger({
          event_data: { agent_id: { ref: 'Target' } },
        }),
        parameters: { Value: 'unused' },
      });
    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    const resources: { logical_id: string; physical_resource_id: string }[] =
      res.body.resources;
    const physicalId = (logicalId: string) => {
      return resources.find((resource) => {
        return resource.logical_id === logicalId;
      })?.physical_resource_id;
    };

    const trigger = await client().get(`/api/v1/triggers/${physicalId('Res')}`);
    expect(trigger.status).toBe(200);
    expect(trigger.body.event_data).toEqual({ agent_id: physicalId('Target') });
  });
});
