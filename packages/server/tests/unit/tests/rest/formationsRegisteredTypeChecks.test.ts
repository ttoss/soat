import {
  registerFormationResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type FakeFormationHandler,
  startFakeFormationHandler,
} from '../../fixtures/formationHandler';
import { authenticatedTestClient } from '../../testClient';

// Validation, plan-time drift and output resolution for an operator-registered
// type. Each is decided by what its registration declares — the `validate` and
// `read` capabilities — and each reaches the handler on localhost, so what the
// handler received is observable next to what the route answered.

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

const register = (options: RegistrationOptions, url?: string) => {
  const registration = handler.registration(options);
  registerFormationResourceTypes({
    registrations: [
      url
        ? { ...registration, handler: { ...registration.handler, url } }
        : registration,
    ],
  });
};

const unregister = () => {
  unregisterFormationResourceTypes({ names: ['test_channel'] });
};

/**
 * Registers `test_channel` for every test in the enclosing `describe`. A
 * registry mutation must never outlive the test that made it.
 */
const withRegisteredType = (options: RegistrationOptions = {}) => {
  beforeEach(() => {
    handler.reset();
    register(options);
  });

  afterEach(unregister);
};

const validate = (template: unknown) => {
  return authenticatedTestClient(userToken)
    .post('/api/v1/formations/validate')
    .send({ template });
};

const createFormation = async (template: unknown) => {
  formationCounter += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `registered-type-checks-${String(formationCounter)}`,
      template,
    });
  expect(res.status).toBe(201);
  return res;
};

const plan = (args: { template: unknown; formationId?: string }) => {
  return authenticatedTestClient(userToken)
    .post('/api/v1/formations/plan')
    .send({
      project_id: projectId,
      template: args.template,
      ...(args.formationId ? { formation_id: args.formationId } : {}),
    });
};

beforeAll(async () => {
  handler = await startFakeFormationHandler();

  const setup = await setupProjectWithUsers({
    prefix: 'fmregchecks',
    policyActions: [
      'formations:ValidateFormation',
      'formations:PlanFormation',
      'formations:CreateFormation',
      'formations:GetFormation',
      'memories:CreateMemoryStore',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

afterAll(async () => {
  await handler.close();
});

describe('POST /api/v1/formations/validate — operator-registered type', () => {
  describe('without the `validate` capability', () => {
    withRegisteredType();

    test('accepts a template that satisfies the registration schema', async () => {
      const res = await validate(
        channelTemplate({ name: 'Support', kind: 'whatsapp' })
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, errors: [], warnings: [] });
      // Plan-time validation is the schema alone: no handler round trip.
      expect(handler.recorded).toEqual([]);
    });

    test('reports a field the registration schema does not declare', async () => {
      const res = await validate(
        channelTemplate({ name: 'S', kind: 'w', nope: 'x' })
      );

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              "Unknown test_channel field 'nope'"
            ),
          }),
        ])
      );
    });

    test('reports a field the registration schema requires', async () => {
      const res = await validate(channelTemplate({ name: 'S' }));

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('`kind` is required'),
          }),
        ])
      );
    });

    test('reports a field of the wrong type', async () => {
      const res = await validate(channelTemplate({ name: 7, kind: 'w' }));

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'resources.Chan.properties.name' }),
        ])
      );
    });

    test('rejects a non-object properties bag naming the type', async () => {
      const res = await validate({
        resources: { Chan: { type: 'test_channel', properties: 'nope' } },
      });

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          {
            path: 'resources.Chan.properties',
            message: 'test_channel `properties` must be an object',
          },
        ])
      );
    });
  });

  describe('with the `validate` capability', () => {
    withRegisteredType({ capabilities: ['validate'] });

    test('the handler verdict is the validation result', async () => {
      handler.replies.validate = {
        status: 200,
        body: {
          errors: [{ path: 'properties.kind', message: 'unsupported kind' }],
        },
      };

      const res = await validate(
        channelTemplate({ name: 'A', kind: 'carrier-pigeon' })
      );

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        { path: 'properties.kind', message: 'unsupported kind' },
      ]);
      expect(
        requestsOfType('validate').map((request) => {
          return request.body;
        })
      ).toEqual([
        {
          request_type: 'validate',
          resource_type: 'test_channel',
          logical_id: '',
          properties: { name: 'A', kind: 'carrier-pigeon' },
        },
      ]);
    });

    test('an empty errors list from the handler means valid', async () => {
      handler.replies.validate = { status: 200, body: { errors: [] } };

      const res = await validate(channelTemplate({ name: 'A', kind: 'w' }));

      expect(res.body).toEqual({ valid: true, errors: [], warnings: [] });
    });

    test('an answer with no errors list means valid', async () => {
      handler.replies.validate = { status: 200, body: {} };

      const res = await validate(channelTemplate({ name: 'A', kind: 'w' }));

      expect(res.body.valid).toBe(true);
    });

    test('malformed handler error entries are skipped, not crashed on', async () => {
      handler.replies.validate = {
        status: 200,
        body: {
          errors: [
            'not-an-object',
            { path: 'p' },
            { message: 'the only usable one' },
          ],
        },
      };

      const res = await validate(channelTemplate({ name: 'A', kind: 'w' }));

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        { path: '', message: 'the only usable one' },
      ]);
    });

    test('a template that fails locally never reaches the handler', async () => {
      const res = await validate(channelTemplate({ name: 'A' }));

      expect(res.body.valid).toBe(false);
      expect(requestsOfType('validate')).toEqual([]);
    });

    test('a template of built-in types alone makes no handler call', async () => {
      const res = await validate({
        resources: {
          Mem: { type: 'memory_store', properties: { name: 'M' } },
        },
      });

      expect(res.body.valid).toBe(true);
      expect(handler.recorded).toEqual([]);
    });
  });
});

describe('POST /api/v1/formations/plan — operator-registered type', () => {
  describe('with the `read` capability', () => {
    withRegisteredType({ capabilities: ['read'] });

    const deployed = async () => {
      handler.replies.create = {
        status: 200,
        body: { physical_resource_id: 'chn_42' },
      };
      const res = await createFormation(
        channelTemplate({ name: 'Support', kind: 'whatsapp' })
      );
      handler.recorded.length = 0;
      return res.body.id as string;
    };

    test('reports no-op when the handler reads back the declared properties', async () => {
      const formationId = await deployed();
      handler.replies.read = {
        status: 200,
        body: {
          exists: true,
          physical_resource_id: 'chn_42',
          properties: { name: 'Support', kind: 'whatsapp' },
        },
      };

      const res = await plan({
        formationId,
        template: channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      });

      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([
        {
          logical_id: 'Chan',
          resource_type: 'test_channel',
          action: 'no-op',
          physical_resource_id: 'chn_42',
          diff: {
            desired: { name: 'Support', kind: 'whatsapp' },
            current: { name: 'Support', kind: 'whatsapp' },
          },
        },
      ]);
      expect(
        requestsOfType('read').map((request) => {
          return request.body;
        })
      ).toEqual([
        {
          request_type: 'read',
          resource_type: 'test_channel',
          logical_id: '',
          project_id: projectId,
          physical_resource_id: 'chn_42',
        },
      ]);
    });

    test('reports update when the live properties differ', async () => {
      const formationId = await deployed();
      handler.replies.read = {
        status: 200,
        body: {
          exists: true,
          physical_resource_id: 'chn_42',
          properties: { name: 'Support', kind: 'discord' },
        },
      };

      const res = await plan({
        formationId,
        template: channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      });

      expect(res.body.changes[0].action).toBe('update');
      expect(res.body.changes[0].diff.current).toEqual({
        name: 'Support',
        kind: 'discord',
      });
    });

    test('a resource the handler says is gone reads as drift', async () => {
      const formationId = await deployed();
      handler.replies.read = { status: 200, body: { exists: false } };

      const res = await plan({
        formationId,
        template: channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      });

      expect(res.status).toBe(200);
      expect(res.body.changes[0].action).toBe('update');
      expect(res.body.changes[0].diff.current).toBeNull();
    });

    test('a read answering with a non-object properties bag reads as gone', async () => {
      const formationId = await deployed();
      handler.replies.read = {
        status: 200,
        body: { exists: true, physical_resource_id: 'chn_42', properties: 'x' },
      };

      const res = await plan({
        formationId,
        template: channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      });

      expect(res.body.changes[0].action).toBe('update');
      expect(res.body.changes[0].diff.current).toBeNull();
    });

    test('a handler that cannot be reached reads as drift rather than failing the plan', async () => {
      const formationId = await deployed();
      unregister();
      register({ capabilities: ['read'] }, 'http://127.0.0.1:1/nope');

      const res = await plan({
        formationId,
        template: channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      });

      expect(res.status).toBe(200);
      expect(res.body.changes[0].action).toBe('update');
    });
  });

  describe('without the `read` capability', () => {
    withRegisteredType();

    test('an existing resource is reported as update, never as no-op', async () => {
      // A type with nothing to read its live state from is exempt from drift
      // detection, so the plan cannot claim it is unchanged.
      handler.replies.create = {
        status: 200,
        body: { physical_resource_id: 'chn_77' },
      };
      const created = await createFormation(
        channelTemplate({ name: 'Support', kind: 'whatsapp' })
      );
      handler.recorded.length = 0;

      const res = await plan({
        formationId: created.body.id,
        template: channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      });

      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([
        {
          logical_id: 'Chan',
          resource_type: 'test_channel',
          action: 'update',
          physical_resource_id: 'chn_77',
          diff: {
            desired: { name: 'Support', kind: 'whatsapp' },
            current: null,
          },
        },
      ]);
      expect(handler.recorded).toEqual([]);
    });
  });
});

describe('POST /api/v1/formations — `ref_attr` outputs of an operator-registered type', () => {
  const templateWithOutputs = (outputs: Record<string, unknown>) => {
    return {
      ...channelTemplate({ name: 'Support', kind: 'whatsapp' }),
      outputs,
    };
  };

  describe('with the `read` capability', () => {
    withRegisteredType({ capabilities: ['read'] });

    beforeEach(() => {
      handler.replies.create = {
        status: 200,
        body: { physical_resource_id: 'chn_42' },
      };
    });

    test('resolves the string attributes the handler publishes', async () => {
      handler.replies.read = {
        status: 200,
        body: {
          exists: true,
          physical_resource_id: 'chn_42',
          properties: { name: 'Support', kind: 'whatsapp' },
          outputs: { webhook_url: 'https://hook', port: 443 },
        },
      };

      const res = await createFormation(
        templateWithOutputs({
          hook: { ref_attr: 'Chan.webhook_url' },
          // `ref_attr` resolves to a string: a non-string is skipped, never
          // coerced, and an unpublished name resolves to nothing.
          port: { ref_attr: 'Chan.port' },
          missing: { ref_attr: 'Chan.missing' },
          id: { ref: 'Chan' },
        })
      );

      expect(res.body.status).toBe('active');
      expect(res.body.outputs).toEqual({ hook: 'https://hook', id: 'chn_42' });
      expect(requestsOfType('read')[0].body.project_id).toBe(projectId);
    });

    test('a read answering without an outputs bag resolves nothing', async () => {
      handler.replies.read = {
        status: 200,
        body: { exists: true, physical_resource_id: 'chn_42', properties: {} },
      };

      const res = await createFormation(
        templateWithOutputs({ hook: { ref_attr: 'Chan.webhook_url' } })
      );

      expect(res.body.status).toBe('active');
      expect(res.body.outputs).toEqual({});
    });

    test('a read the handler refuses resolves nothing and does not fail the deploy', async () => {
      handler.replies.read = { status: 500, body: { message: 'down' } };

      const res = await createFormation(
        templateWithOutputs({ hook: { ref_attr: 'Chan.webhook_url' } })
      );

      expect(res.body.status).toBe('active');
      expect(res.body.outputs).toEqual({});
    });
  });

  describe('without the `read` capability', () => {
    withRegisteredType();

    test('a type that publishes no attributes resolves nothing', async () => {
      handler.replies.create = {
        status: 200,
        body: { physical_resource_id: 'chn_43' },
      };

      const res = await createFormation(
        templateWithOutputs({ hook: { ref_attr: 'Chan.webhook_url' } })
      );

      expect(res.body.status).toBe('active');
      expect(res.body.outputs).toEqual({});
      expect(requestsOfType('read')).toEqual([]);
    });
  });
});
