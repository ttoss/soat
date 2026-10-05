import crypto from 'node:crypto';

import { db } from 'src/db';
import {
  registerFormationResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  deletedPhysicalIds,
  type FakeFormationHandler,
  HANDLER_SECRET,
  startFakeFormationHandler,
} from '../../fixtures/formationHandler';
import { authenticatedTestClient } from '../../testClient';

// An operator-registered type points its lifecycle at an external HTTP
// handler. The handler runs on localhost, so every request the deploy makes is
// genuinely serialized and signed, and what it received is the observable.

type RegistrationOptions = Parameters<FakeFormationHandler['registration']>[0];

let handler: FakeFormationHandler;
let userToken: string;
let projectId: string;
let formationCounter = 0;

const channelTemplate = (properties: Record<string, unknown>) => {
  return { resources: { Chan: { type: 'test_channel', properties } } };
};

const requestsOfType = (type: string) => {
  return handler.recorded.filter((request) => {
    return request.body.request_type === type;
  });
};

const formationRow = async (publicId: string) => {
  const row = await db.Formation.findOne({ where: { publicId } });
  if (!row) throw new Error(`formation ${publicId} not found`);
  return row;
};

const createFormation = (template: unknown) => {
  formationCounter += 1;
  return authenticatedTestClient(userToken)
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `registered-type-${String(formationCounter)}`,
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

const deleteFormation = (formationId: string) => {
  return authenticatedTestClient(userToken).delete(
    `/api/v1/formations/${formationId}`
  );
};

/**
 * Registers `test_channel` for every test in the enclosing `describe`. A
 * registry mutation must never outlive the test that made it, or another test
 * would see a type it never declared.
 */
const withRegisteredType = (options: RegistrationOptions = {}) => {
  beforeEach(() => {
    handler.reset();
    registerFormationResourceTypes({
      registrations: [handler.registration(options)],
    });
  });

  afterEach(() => {
    unregisterFormationResourceTypes({ names: ['test_channel'] });
  });
};

/** Registers `test_channel` pointed at a URL other than the fake handler. */
const withRegisteredTypeAt = (url: string) => {
  beforeEach(() => {
    handler.reset();
    const registration = handler.registration({});
    registerFormationResourceTypes({
      registrations: [
        { ...registration, handler: { ...registration.handler, url } },
      ],
    });
  });

  afterEach(() => {
    unregisterFormationResourceTypes({ names: ['test_channel'] });
  });
};

beforeAll(async () => {
  handler = await startFakeFormationHandler();

  // A registered type's operations are in no permission catalog, so the
  // formation's own actions are the whole grant a deploy needs.
  const setup = await setupProjectWithUsers({
    prefix: 'fmregtype',
    policyActions: [
      'formations:CreateFormation',
      'formations:UpdateFormation',
      'formations:DeleteFormation',
      'formations:GetFormation',
      'formations:ListFormationEvents',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

afterAll(async () => {
  await handler.close();
});

describe('POST /api/v1/formations — operator-registered type', () => {
  withRegisteredType();

  test('posts a signed create carrying the resource context and records the returned id', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_42' },
    };

    const res = await createFormation(
      channelTemplate({ name: 'Support', kind: 'whatsapp' })
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.resources[0].physical_resource_id).toBe('chn_42');

    expect(handler.recorded).toHaveLength(1);
    const [request] = handler.recorded;
    expect(request.body).toEqual({
      request_type: 'create',
      resource_type: 'test_channel',
      logical_id: 'Chan',
      project_id: projectId,
      properties: { name: 'Support', kind: 'whatsapp' },
    });

    // Verified independently, over the body the handler actually received.
    const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(
      String(request.headers['x-soat-signature'])
    );
    expect(match).not.toBeNull();
    const [, timestamp, digest] = match as RegExpExecArray;
    const expected = crypto
      .createHmac('sha256', HANDLER_SECRET)
      .update(`${timestamp}.${JSON.stringify(request.body)}`)
      .digest('hex');
    expect(digest).toBe(expected);
  });

  test('the idempotency key is distinct per resource', async () => {
    handler.replies.create = (request) => {
      return {
        status: 200,
        body: { physical_resource_id: `chn_${String(request.logical_id)}` },
      };
    };

    const res = await createFormation({
      resources: {
        First: { type: 'test_channel', properties: { name: 'A', kind: 'k' } },
        Second: { type: 'test_channel', properties: { name: 'B', kind: 'k' } },
      },
    });

    expect(res.status).toBe(201);
    const keys = handler.recorded.map((request) => {
      return request.headers['x-soat-idempotency-key'];
    });
    expect(keys).toHaveLength(2);
    expect(typeof keys[0]).toBe('string');
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('re-applying a failed create sends the same idempotency key', async () => {
    handler.replies.create = {
      status: 503,
      body: {},
    };
    const failed = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );
    expect(failed.status).toBe(201);
    expect(failed.body.status).toBe('failed');

    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_retry' },
    };
    const retried = await updateFormation(
      failed.body.id,
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );

    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('active');
    const keys = requestsOfType('create').map((request) => {
      return request.headers['x-soat-idempotency-key'];
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('a 4xx fails the deploy with the handler message verbatim', async () => {
    handler.replies.create = {
      status: 422,
      body: { message: 'kind "whatsapp" needs a verified number' },
    };

    const res = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toBe(
      'Formation handler for \'test_channel\' failed on create: kind "whatsapp" needs a verified number (HTTP 422)'
    );
  });

  test('a 5xx with no message still names the type and the status', async () => {
    handler.replies.create = { status: 503, body: {} };

    const res = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toBe(
      "Formation handler for 'test_channel' failed on create: HTTP 503"
    );
  });

  test('a 2xx create with no physical_resource_id fails the deploy', async () => {
    // Recording it would leave a resource the engine can never address again:
    // neither an update nor a delete would have anything to send.
    handler.replies.create = { status: 200, body: { outputs: {} } };

    const res = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toMatch(/physical_resource_id/);
  });

  test('a 2xx body that is not a JSON object fails the deploy', async () => {
    handler.replies.create = { status: 200, body: 'not-an-object' };

    const res = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toMatch(
      /^Formation handler for 'test_channel' failed on create/
    );
  });

  test('a failed create unwinds the resources the same deploy already created', async () => {
    handler.replies.create = (request) => {
      return request.logical_id === 'First'
        ? { status: 200, body: { physical_resource_id: 'chn_first' } }
        : { status: 422, body: { message: 'second refused' } };
    };
    handler.replies.delete = { status: 200, body: {} };

    const res = await createFormation({
      resources: {
        First: { type: 'test_channel', properties: { name: 'A', kind: 'k' } },
        Second: {
          type: 'test_channel',
          properties: { name: 'B', kind: 'k', agent_id: { ref: 'First' } },
        },
      },
    });

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toMatch(/second refused/);
    expect(deletedPhysicalIds(handler)).toEqual(['chn_first']);
  });

  test('an unwind the handler refuses is recorded without replacing the original failure', async () => {
    handler.replies.create = (request) => {
      return request.logical_id === 'First'
        ? { status: 200, body: { physical_resource_id: 'chn_stuck' } }
        : { status: 422, body: { message: 'second refused' } };
    };
    handler.replies.delete = { status: 500, body: { message: 'stuck' } };

    const res = await createFormation({
      resources: {
        First: { type: 'test_channel', properties: { name: 'A', kind: 'k' } },
        Second: {
          type: 'test_channel',
          properties: { name: 'B', kind: 'k', agent_id: { ref: 'First' } },
        },
      },
    });

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toMatch(/second refused/);

    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'First',
          action: 'rollback',
          status: 'failed',
          physical_resource_id: 'chn_stuck',
          error: expect.stringContaining('stuck'),
        }),
      ])
    );
  });
});

describe('POST /api/v1/formations — handler transport failures', () => {
  describe('an unreachable handler', () => {
    withRegisteredTypeAt('http://127.0.0.1:1/nope');

    test('fails the deploy rather than silently succeeding', async () => {
      const res = await createFormation(
        channelTemplate({ name: 'A', kind: 'whatsapp' })
      );

      expect(res.body.status).toBe('failed');
      expect(res.body.error.message).toMatch(
        /^Formation handler for 'test_channel' failed on create: request failed/
      );
    });
  });

  describe('a handler slower than its timeout', () => {
    withRegisteredType({ timeoutMs: 50 });

    test('fails the operation', async () => {
      handler.holdMs = 200;

      const res = await createFormation(
        channelTemplate({ name: 'A', kind: 'whatsapp' })
      );

      expect(res.body.status).toBe('failed');
      // Under jest the abort's DOMException comes from another realm, so it is
      // reported through the generic transport branch rather than as a timeout.
      expect(res.body.error.message).toMatch(
        /^Formation handler for 'test_channel' failed on create: request (timed out after 50ms|failed: TimeoutError)/
      );
    });
  });
});

describe('POST /api/v1/formations — write-only properties', () => {
  withRegisteredType({ writeOnlyProperties: ['config'] });

  test('the handler receives the value but the stored snapshot omits it', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_wo' },
    };

    const res = await createFormation(
      channelTemplate({
        name: 'A',
        kind: 'whatsapp',
        config: { token: 'sk_live' },
      })
    );

    expect(res.body.status).toBe('active');
    // Stripping is about what is stored, never about what is sent: a create
    // that withheld the credential would provision nothing.
    expect(handler.recorded[0].body.properties).toEqual({
      name: 'A',
      kind: 'whatsapp',
      config: { token: 'sk_live' },
    });

    const resource = await db.FormationResource.findOne({
      where: {
        formationId: (await formationRow(res.body.id)).id,
        logicalId: 'Chan',
      },
    });
    expect(resource!.lastAppliedProperties).toEqual({
      name: 'A',
      kind: 'whatsapp',
    });
  });
});

describe('PUT /api/v1/formations/:formation_id — operator-registered type', () => {
  withRegisteredType({ capabilities: ['validate', 'read'] });

  test('an in-place update posts the physical id with the properties', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_100' },
    };
    const created = await createFormation(
      channelTemplate({ name: 'Support', kind: 'whatsapp' })
    );
    handler.recorded.length = 0;
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_100' },
    };

    const res = await updateFormation(
      created.body.id,
      channelTemplate({ name: 'Renamed', kind: 'whatsapp' })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.resources[0].physical_resource_id).toBe('chn_100');
    expect(
      requestsOfType('update').map((request) => {
        return request.body;
      })
    ).toEqual([
      {
        request_type: 'update',
        resource_type: 'test_channel',
        logical_id: 'Chan',
        project_id: projectId,
        physical_resource_id: 'chn_100',
        properties: { name: 'Renamed', kind: 'whatsapp' },
      },
    ]);
    expect(deletedPhysicalIds(handler)).toEqual([]);
  });

  test('an update answering with a new id replaces the resource and disposes of the old one', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_200' },
    };
    const created = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_201' },
    };
    handler.replies.delete = { status: 200, body: {} };

    const res = await updateFormation(
      created.body.id,
      channelTemplate({ name: 'A', kind: 'discord' })
    );

    expect(res.body.status).toBe('active');
    expect(res.body.error).toBeNull();
    expect(res.body.resources[0].physical_resource_id).toBe('chn_201');
    expect(deletedPhysicalIds(handler)).toEqual(['chn_200']);
  });

  test('a failed disposal leaks the old resource but does not fail the deploy', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_300' },
    };
    const created = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_301' },
    };
    handler.replies.delete = {
      status: 500,
      body: { message: 'cannot delete' },
    };

    const res = await updateFormation(
      created.body.id,
      channelTemplate({ name: 'A', kind: 'discord' })
    );

    // The desired state is realised, so the deploy succeeds; the leak is
    // reported on the formation rather than rolled back.
    expect(res.body.status).toBe('active');
    expect(res.body.resources[0].physical_resource_id).toBe('chn_301');
    expect(res.body.error.code).toBe('FORMATION_REPLACE_CLEANUP_FAILED');
    expect(res.body.error.message).toContain('chn_300 (Chan)');
    expect(res.body.error.meta.failures).toEqual([
      {
        logical_id: 'Chan',
        resource_type: 'test_channel',
        physical_resource_id: 'chn_300',
        error: expect.stringContaining('cannot delete'),
      },
    ]);
  });

  test('a failed disposal is retried by the next deploy and clears once it succeeds', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_310' },
    };
    const created = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_311' },
    };
    handler.replies.delete = {
      status: 500,
      body: { message: 'cannot delete' },
    };
    await updateFormation(
      created.body.id,
      channelTemplate({ name: 'A', kind: 'discord' })
    );

    handler.recorded.length = 0;
    handler.replies.update = (request) => {
      return {
        status: 200,
        body: { physical_resource_id: request.physical_resource_id },
      };
    };
    handler.replies.delete = { status: 200, body: {} };

    const res = await updateFormation(
      created.body.id,
      channelTemplate({ name: 'B', kind: 'discord' })
    );

    expect(deletedPhysicalIds(handler)).toEqual(['chn_310']);
    expect(res.body.status).toBe('active');
    expect(res.body.error).toBeNull();
  });

  test('a replaced resource is disposed of only after its dependents are re-pointed', async () => {
    // A type whose delete refuses over live references could never be cleaned
    // up if the disposal ran while a dependent still pointed at it.
    handler.replies.create = (request) => {
      return {
        status: 200,
        body: {
          physical_resource_id:
            request.logical_id === 'Chan' ? 'chn_500' : 'dep_500',
        },
      };
    };
    const dependentTemplate = (kind: string) => {
      return {
        resources: {
          Chan: { type: 'test_channel', properties: { name: 'A', kind } },
          Dep: {
            type: 'test_channel',
            properties: {
              name: 'D',
              kind: 'whatsapp',
              agent_id: { ref: 'Chan' },
            },
          },
        },
      };
    };
    const created = await createFormation(dependentTemplate('whatsapp'));
    expect(created.body.status).toBe('active');

    handler.recorded.length = 0;
    handler.replies.update = (request) => {
      return request.physical_resource_id === 'chn_500'
        ? { status: 200, body: { physical_resource_id: 'chn_501' } }
        : {
            status: 200,
            body: { physical_resource_id: request.physical_resource_id },
          };
    };
    handler.replies.delete = { status: 200, body: {} };

    const res = await updateFormation(
      created.body.id,
      dependentTemplate('discord')
    );

    expect(res.body.status).toBe('active');
    expect(
      handler.recorded
        .filter((request) => {
          return (
            request.body.request_type === 'update' ||
            request.body.request_type === 'delete'
          );
        })
        .map((request) => {
          return `${String(request.body.request_type)}:${String(
            request.body.physical_resource_id
          )}`;
        })
    ).toEqual(['update:chn_500', 'update:dep_500', 'delete:chn_500']);
    // The dependent now references the replacement, not what it superseded.
    expect(
      requestsOfType('update').find((request) => {
        return request.body.logical_id === 'Dep';
      })?.body.properties
    ).toEqual({ name: 'D', kind: 'whatsapp', agent_id: 'chn_501' });
  });

  test('a retained resource is not disposed of when it is replaced', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_400' },
    };
    const retained = (kind: string) => {
      return {
        resources: {
          Chan: {
            type: 'test_channel',
            properties: { name: 'A', kind },
            deletion_policy: 'retain',
          },
        },
      };
    };
    const created = await createFormation(retained('whatsapp'));
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_401' },
    };

    const res = await updateFormation(created.body.id, retained('discord'));

    expect(res.body.status).toBe('active');
    expect(res.body.resources[0].physical_resource_id).toBe('chn_401');
    expect(requestsOfType('delete')).toEqual([]);
  });

  test('a removed resource the handler refuses to delete is reported on the operation', async () => {
    handler.replies.create = (request) => {
      return {
        status: 200,
        body: { physical_resource_id: `chn_${String(request.logical_id)}` },
      };
    };
    const created = await createFormation({
      resources: {
        Keep: { type: 'test_channel', properties: { name: 'K', kind: 'k' } },
        Drop: { type: 'test_channel', properties: { name: 'D', kind: 'k' } },
      },
    });
    handler.replies.delete = { status: 500, body: { message: 'refused' } };

    const res = await updateFormation(created.body.id, {
      resources: {
        Keep: { type: 'test_channel', properties: { name: 'K', kind: 'k' } },
      },
    });

    expect(res.body.status).toBe('active');
    expect(deletedPhysicalIds(handler)).toEqual(['chn_Drop']);
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Drop',
          action: 'delete',
          status: 'failed',
          error: expect.stringContaining('refused'),
        }),
      ])
    );
  });
});

describe('DELETE /api/v1/formations/:formation_id — operator-registered type', () => {
  withRegisteredType({ capabilities: ['read'] });

  test('posts a delete carrying the physical id and the resource context', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_700' },
    };
    const created = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );
    handler.replies.delete = { status: 200, body: {} };

    const res = await deleteFormation(created.body.id);

    expect(res.status).toBe(200);
    expect(
      requestsOfType('delete').map((request) => {
        return request.body;
      })
    ).toEqual([
      {
        request_type: 'delete',
        resource_type: 'test_channel',
        logical_id: 'Chan',
        project_id: projectId,
        physical_resource_id: 'chn_700',
      },
    ]);
  });

  test('a leaked replacement is swept when the formation is torn down', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_320' },
    };
    const created = await createFormation(
      channelTemplate({ name: 'A', kind: 'whatsapp' })
    );
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_321' },
    };
    handler.replies.delete = {
      status: 500,
      body: { message: 'cannot delete' },
    };
    await updateFormation(
      created.body.id,
      channelTemplate({ name: 'A', kind: 'discord' })
    );

    handler.recorded.length = 0;
    handler.replies.delete = { status: 200, body: {} };
    const res = await deleteFormation(created.body.id);

    expect(res.status).toBe(200);
    expect(deletedPhysicalIds(handler)).toEqual(['chn_320', 'chn_321']);
  });
});
