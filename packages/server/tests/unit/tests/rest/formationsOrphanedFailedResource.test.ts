import {
  registerFormationResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type FakeFormationHandler,
  startFakeFormationHandler,
  TEST_CHANNEL_ACTIONS,
} from '../../fixtures/formationHandler';
import { authenticatedTestClient } from '../../testClient';

// A resource whose create failed has nothing behind it; once the template
// stops declaring it, it is retired like any other dropped resource.

let handler: FakeFormationHandler;
let userToken: string;
let projectId: string;

const original = {
  resources: {
    Chan: { type: 'test_channel', properties: { name: 'A', kind: 'k' } },
  },
};

const withBroken = {
  resources: {
    ...original.resources,
    Broken: { type: 'test_channel', properties: { name: 'B', kind: 'k' } },
  },
};

beforeAll(async () => {
  handler = await startFakeFormationHandler();
  const setup = await setupProjectWithUsers({
    prefix: 'fmorphfail',
    policyActions: [
      'formations:CreateFormation',
      'formations:UpdateFormation',
      'formations:GetFormation',
      'formations:PlanFormation',
      'formations:ListFormationEvents',
      ...TEST_CHANNEL_ACTIONS,
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

afterAll(async () => {
  await handler.close();
});

beforeEach(() => {
  handler.reset();
  registerFormationResourceTypes({ registrations: [handler.registration({})] });
});

afterEach(() => {
  unregisterFormationResourceTypes({ names: ['test_channel'] });
});

const brokenRow = async (formationId: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/formations/${formationId}`
  );
  expect(res.status).toBe(200);
  return res.body.resources.find((r: Record<string, unknown>) => {
    return r.logical_id === 'Broken';
  });
};

describe('PUT /api/v1/formations/:formation_id — dropping a resource whose create failed', () => {
  test('the dropped resource is deleted, and plan agrees with apply', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_a' },
    };
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'orphan-failed',
        template: original,
      });
    expect(created.body.status).toBe('active');
    const formationId: string = created.body.id;

    handler.replies.create = {
      status: 422,
      body: { message: 'broken refused' },
    };
    const failed = await authenticatedTestClient(userToken)
      .put(`/api/v1/formations/${formationId}`)
      .send({ template: withBroken });
    expect(failed.body.status).toBe('failed');
    expect(await brokenRow(formationId)).toMatchObject({
      status: 'failed',
    });

    const plan = await authenticatedTestClient(userToken)
      .post('/api/v1/formations/plan')
      .send({
        project_id: projectId,
        formation_id: formationId,
        template: original,
      });
    expect(plan.status).toBe(200);
    expect(
      plan.body.changes.filter((c: Record<string, unknown>) => {
        return c.logical_id === 'Broken';
      })
    ).toEqual([
      { logical_id: 'Broken', resource_type: 'test_channel', action: 'delete' },
    ]);

    handler.recorded.length = 0;
    const redeployed = await authenticatedTestClient(userToken)
      .put(`/api/v1/formations/${formationId}`)
      .send({ template: original });
    expect(redeployed.body.status).toBe('active');
    expect(await brokenRow(formationId)).toMatchObject({
      status: 'deleted',
    });
    expect(
      handler.recorded.filter((request) => {
        return request.body.request_type === 'delete';
      })
    ).toEqual([]);

    const events = await authenticatedTestClient(userToken).get(
      `/api/v1/formations/${formationId}/events`
    );
    expect(events.body.data[events.body.data.length - 1].events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Broken',
          action: 'delete',
          status: 'completed',
        }),
      ])
    );
  });
});
