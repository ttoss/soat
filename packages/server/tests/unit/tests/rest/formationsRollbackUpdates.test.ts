import { db } from 'src/db';
import {
  registerFormationResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  deletedPhysicalIds,
  type FakeFormationHandler,
  startFakeFormationHandler,
  TEST_CHANNEL_ACTIONS,
} from '../../fixtures/formationHandler';
import { authenticatedTestClient } from '../../testClient';

// A failed deploy leaves the stack as it was: the resources it updated are
// restored along with the creates it walks back, so nothing it keeps can
// reference a resource the unwind removed.

let handler: FakeFormationHandler;
let userToken: string;
let projectId: string;
let formationCounter = 0;

const createFormation = (template: unknown) => {
  formationCounter += 1;
  return authenticatedTestClient(userToken)
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `rollback-updates-${String(formationCounter)}`,
      template,
    });
};

const updateFormation = (formationId: string, template: unknown) => {
  return authenticatedTestClient(userToken)
    .put(`/api/v1/formations/${formationId}`)
    .send({ template });
};

const latestOperationEvents = async (formationId: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/formations/${formationId}/events`
  );
  expect(res.status).toBe(200);
  return res.body.data[res.body.data.length - 1].events;
};

const writeRequests = () => {
  return handler.recorded
    .filter((request) => {
      return request.body.request_type !== 'validate';
    })
    .map((request) => {
      return `${String(request.body.request_type)}:${String(
        request.body.logical_id
      )}:${String(request.body.physical_resource_id)}`;
    });
};

const echoUpdate = (request: Record<string, unknown>) => {
  return {
    status: 200,
    body: { physical_resource_id: request.physical_resource_id },
  };
};

const chanRow = async (formationPublicId: string) => {
  const row = await db.FormationResource.findOne({
    where: { logicalId: 'Chan' },
    include: [
      {
        model: db.Formation,
        where: { publicId: formationPublicId },
        required: true,
      },
    ],
  });
  if (!row) throw new Error('no Chan row');
  return row;
};

const original = {
  resources: {
    Chan: { type: 'test_channel', properties: { name: 'A', kind: 'k' } },
  },
};

const failingAfter = (chan: Record<string, unknown>, extra = {}) => {
  return {
    resources: {
      ...extra,
      Chan: { type: 'test_channel', properties: chan },
      Broken: {
        type: 'test_channel',
        properties: { name: 'B', kind: 'k', agent_id: { ref: 'Chan' } },
      },
    },
  };
};

beforeAll(async () => {
  handler = await startFakeFormationHandler();
  const setup = await setupProjectWithUsers({
    prefix: 'fmrollupd',
    policyActions: [
      'formations:CreateFormation',
      'formations:UpdateFormation',
      'formations:GetFormation',
      'formations:ListFormationEvents',
      ...TEST_CHANNEL_ACTIONS,
      'agents:CreateAgentGeneration',
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

describe('PUT /api/v1/formations/:formation_id — a deploy that fails after an update', () => {
  test('restores the update before walking back the create it referenced', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_a' },
    };
    const created = await createFormation(original);
    expect(created.body.status).toBe('active');

    handler.recorded.length = 0;
    handler.replies.create = (request) => {
      return request.logical_id === 'New'
        ? { status: 200, body: { physical_resource_id: 'chn_new' } }
        : { status: 422, body: { message: 'broken refused' } };
    };
    handler.replies.update = echoUpdate;
    handler.replies.delete = { status: 200, body: {} };

    const res = await updateFormation(
      created.body.id,
      failingAfter(
        { name: 'A', kind: 'k', agent_id: { ref: 'New' } },
        {
          New: { type: 'test_channel', properties: { name: 'N', kind: 'k' } },
        }
      )
    );

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toMatch(/broken refused/);
    expect(writeRequests()).toEqual([
      'create:New:undefined',
      'update:Chan:chn_a',
      'create:Broken:undefined',
      'update:Chan:chn_a',
      'delete:New:chn_new',
    ]);
    const updates = handler.recorded.filter((request) => {
      return request.body.request_type === 'update';
    });
    expect(updates[1].body.properties).toEqual({ name: 'A', kind: 'k' });
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Chan',
          action: 'rollback',
          status: 'completed',
          physical_resource_id: 'chn_a',
        }),
      ])
    );

    // The ledger is back on what was deployed, so re-deploying it is a no-op.
    handler.recorded.length = 0;
    const redeployed = await updateFormation(created.body.id, original);
    expect(redeployed.body.status).toBe('active');
    expect(writeRequests()).toEqual([]);
  });

  test('a replacement is walked back to the resource it superseded', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_r0' },
    };
    const created = await createFormation(original);

    handler.recorded.length = 0;
    handler.replies.create = {
      status: 422,
      body: { message: 'broken refused' },
    };
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_r1' },
    };
    handler.replies.delete = { status: 200, body: {} };

    const res = await updateFormation(
      created.body.id,
      failingAfter({ name: 'A', kind: 'other' })
    );

    expect(res.body.status).toBe('failed');
    expect(deletedPhysicalIds(handler)).toEqual(['chn_r1']);
    const row = await chanRow(created.body.id);
    expect(row.physicalResourceId).toBe('chn_r0');
    expect(row.pendingCleanupPhysicalResourceIds ?? []).toEqual([]);
    expect(row.lastAppliedProperties).toEqual({ name: 'A', kind: 'k' });
  });

  test('a retained replacement is kept, not deleted', async () => {
    const retained = {
      resources: {
        Chan: {
          type: 'test_channel',
          deletion_policy: 'retain',
          properties: { name: 'A', kind: 'k' },
        },
      },
    };
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_k0' },
    };
    const created = await createFormation(retained);

    handler.replies.create = {
      status: 422,
      body: { message: 'broken refused' },
    };
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_k1' },
    };
    handler.replies.delete = { status: 200, body: {} };

    const res = await updateFormation(created.body.id, {
      resources: {
        ...failingAfter({ name: 'A', kind: 'other' }).resources,
        Chan: {
          ...retained.resources.Chan,
          properties: { name: 'A', kind: 'other' },
        },
      },
    });

    expect(res.body.status).toBe('failed');
    expect(deletedPhysicalIds(handler)).toEqual([]);
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Chan',
          action: 'rollback-skipped',
          physical_resource_id: 'chn_k1',
        }),
      ])
    );
  });

  test('a restore that replaces the resource moves the row to the replacement', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_t0' },
    };
    const created = await createFormation(original);

    handler.replies.create = {
      status: 422,
      body: { message: 'broken refused' },
    };
    let updates = 0;
    handler.replies.update = (request) => {
      updates += 1;
      return updates === 1
        ? echoUpdate(request)
        : { status: 200, body: { physical_resource_id: 'chn_t1' } };
    };

    const res = await updateFormation(
      created.body.id,
      failingAfter({ name: 'A2', kind: 'k' })
    );

    expect(res.body.status).toBe('failed');
    const row = await chanRow(created.body.id);
    expect(row.physicalResourceId).toBe('chn_t1');
    expect(row.pendingCleanupPhysicalResourceIds).toEqual(['chn_t0']);
    expect(row.lastAppliedProperties).toEqual({ name: 'A', kind: 'k' });
  });

  test('a restore the handler refuses is recorded without replacing the original failure', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_s' },
    };
    const created = await createFormation(original);

    handler.replies.create = {
      status: 422,
      body: { message: 'broken refused' },
    };
    let updates = 0;
    handler.replies.update = (request) => {
      updates += 1;
      return updates === 1
        ? echoUpdate(request)
        : { status: 500, body: { message: 'restore stuck' } };
    };

    const res = await updateFormation(
      created.body.id,
      failingAfter({ name: 'A2', kind: 'k' })
    );

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toMatch(/broken refused/);
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Chan',
          action: 'rollback',
          status: 'failed',
          physical_resource_id: 'chn_s',
          error: expect.objectContaining({
            message: expect.stringContaining('restore stuck'),
          }),
        }),
      ])
    );
  });
});

describe('PUT /api/v1/formations/:formation_id — a rolled-back update of a write-only property', () => {
  const declaring = (config: unknown) => {
    return {
      resources: {
        Chan: {
          type: 'test_channel',
          properties: { name: 'A', kind: 'k', config },
        },
      },
    };
  };

  beforeEach(() => {
    unregisterFormationResourceTypes({ names: ['test_channel'] });
    registerFormationResourceTypes({
      registrations: [
        handler.registration({ writeOnlyProperties: ['config'] }),
      ],
    });
  });

  const failUpdate = async (formationId: string, body: object) => {
    handler.recorded.length = 0;
    handler.replies.create = {
      status: 422,
      body: { message: 'broken refused' },
    };
    handler.replies.update = echoUpdate;
    const res = await authenticatedTestClient(userToken)
      .put(`/api/v1/formations/${formationId}`)
      .send(body);
    expect(res.body.status).toBe('failed');
  };

  test('the restore re-sends the value the last deploy declared', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_w' },
    };
    const created = await createFormation(declaring({ token: 'v1' }));
    expect(created.body.status).toBe('active');

    await failUpdate(created.body.id, {
      template: failingAfter({ name: 'A', kind: 'k', config: { token: 'v2' } }),
    });

    const sent = handler.recorded
      .filter((request) => {
        return request.body.request_type === 'update';
      })
      .map((request) => {
        return request.body.properties;
      });
    expect(sent).toEqual([
      { name: 'A', kind: 'k', config: { token: 'v2' } },
      { name: 'A', kind: 'k', config: { token: 'v1' } },
    ]);

    handler.recorded.length = 0;
    const redeployed = await updateFormation(
      created.body.id,
      declaring({ token: 'v1' })
    );
    expect(redeployed.body.status).toBe('active');
    expect(writeRequests()).toEqual([]);
  });

  test('a value the restore cannot resolve is re-sent by the next deploy', async () => {
    const parameters = { Token: { type: 'string', no_echo: true } };
    const masked = { parameters, ...declaring({ token: { param: 'Token' } }) };
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_m' },
    };
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'rollback-updates-masked',
        template: masked,
        parameters: { Token: 'v1' },
      });
    expect(created.body.status).toBe('active');

    await failUpdate(created.body.id, {
      template: {
        parameters,
        ...failingAfter({ name: 'A', kind: 'k', config: { token: 'v2' } }),
      },
    });

    handler.recorded.length = 0;
    handler.replies.update = echoUpdate;
    const redeployed = await authenticatedTestClient(userToken)
      .put(`/api/v1/formations/${String(created.body.id)}`)
      .send({ template: masked, parameters: { Token: 'v1' } });
    expect(redeployed.body.status).toBe('active');
    expect(writeRequests()).toEqual(['update:Chan:chn_m']);
  });
});
