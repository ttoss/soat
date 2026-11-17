import crypto from 'node:crypto';

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

/**
 * A registered type's handler acts as the deployer: each write it receives
 * carries the deployer's authority sealed in a tool assertion, and a callback
 * presenting it in `On-Behalf-Of` is capped by it.
 */

const ASSERTION = 'x-soat-tool-assertion';
const ON_BEHALF_OF = 'X-Soat-On-Behalf-Of';

let handler: FakeFormationHandler;
let adminToken: string;
let userToken: string;
let projectId: string;
let projectKey: string;
let documentId: string;
let counter = 0;
const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

const template = {
  resources: {
    Chan: { type: 'test_channel', properties: { name: 'A', kind: 'x' } },
  },
};

const deploy = async (token: string) => {
  counter += 1;
  const res = await authenticatedTestClient(token)
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `registered-authority-${String(counter)}`,
      template,
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const assertionOf = (requestType: string): string => {
  const request = handler.recorded.find((recorded) => {
    return recorded.body.request_type === requestType;
  });
  const assertion = request?.headers[ASSERTION];
  if (typeof assertion !== 'string') {
    throw new Error(`no assertion on ${requestType}`);
  }
  return assertion;
};

const readDocumentAs = (assertion: string) => {
  return authenticatedTestClient(projectKey)
    .get(`/api/v1/documents/${documentId}`)
    .set(ON_BEHALF_OF, assertion);
};

beforeAll(async () => {
  process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
    .generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  handler = await startFakeFormationHandler();

  const setup = await setupProjectWithUsers({
    prefix: 'fmregauth',
    policyActions: [
      'formations:CreateFormation',
      'formations:DeleteFormation',
      'formations:GetFormation',
      ...TEST_CHANNEL_ACTIONS,
    ],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  projectId = setup.projectId;

  const key = await authenticatedTestClient(adminToken)
    .post('/api/v1/api-keys')
    .send({ name: 'handler key', project_id: projectId });
  expect(key.status).toBe(201);
  projectKey = key.body.key;

  const doc = await authenticatedTestClient(adminToken)
    .post('/api/v1/documents')
    .send({ project_id: projectId, content: 'deployer-only' });
  expect(doc.status).toBe(201);
  documentId = doc.body.id;
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
  else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
  await handler.close();
});

beforeEach(() => {
  handler.reset();
  handler.replies.create = {
    status: 200,
    body: { physical_resource_id: 'chn_auth' },
  };
  handler.replies.delete = { status: 200, body: {} };
  registerFormationResourceTypes({
    registrations: [handler.registration({ capabilities: ['validate'] })],
  });
  handler.replies.validate = { status: 200, body: { errors: [] } };
});

afterEach(() => {
  unregisterFormationResourceTypes({ names: ['test_channel'] });
});

describe('a registered type handler receives the deployer authority', () => {
  test('a callback from a deploy bounded away from an action is 403', async () => {
    await deploy(userToken);

    const res = await readDocumentAs(assertionOf('create'));

    expect(res.status).toBe(403);
  });

  test('a callback from a deploy that holds the action succeeds', async () => {
    await deploy(adminToken);

    const res = await readDocumentAs(assertionOf('create'));

    expect(res.status).toBe(200);
  });

  test('the assertion names the project and the handler, and hides the bound', async () => {
    await deploy(userToken);

    const claims = JSON.parse(
      Buffer.from(assertionOf('create').split('.')[1], 'base64url').toString()
    );

    expect(claims.project_id).toBe(projectId);
    expect(claims.aud).toBe(handler.registration({}).handler.url);
    expect(claims.tool_id).toBeUndefined();
    expect(typeof claims.ath).toBe('string');
    expect(JSON.stringify(claims)).not.toContain('formations:');
  });

  test('a teardown delete carries the deleting caller authority', async () => {
    const formationId = await deploy(adminToken);
    handler.reset();
    handler.replies.delete = { status: 200, body: {} };

    const del = await authenticatedTestClient(userToken).delete(
      `/api/v1/formations/${formationId}`
    );
    expect(del.status).toBe(200);

    const res = await readDocumentAs(assertionOf('delete'));
    expect(res.status).toBe(403);
  });

  test('a validate call carries no assertion', async () => {
    await deploy(userToken);

    const validate = handler.recorded.find((recorded) => {
      return recorded.body.request_type === 'validate';
    });
    expect(validate).toBeDefined();
    expect(validate?.headers[ASSERTION]).toBeUndefined();
  });
});

describe('the runtime asserts what the registration declares, before the handler', () => {
  const deployAsUser = async (
    resources: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    counter += 1;
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: `registered-writer-${String(counter)}`,
        template: { resources },
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const creates = () => {
    return handler.recorded.filter((recorded) => {
      return recorded.body.request_type === 'create';
    });
  };

  test('a deployer without the declared create action is refused', async () => {
    unregisterFormationResourceTypes({ names: ['test_channel'] });
    registerFormationResourceTypes({
      registrations: [
        {
          ...handler.registration({ capabilities: ['validate'] }),
          writer: {
            resourceType: 'agent',
            actions: {
              create: 'agents:CreateAgent',
              update: 'agents:UpdateAgent',
              delete: 'agents:DeleteAgent',
            },
            carries: [],
          },
        },
      ],
    });

    const body = await deployAsUser(template.resources);

    expect(body.status).toBe('failed');
    expect(JSON.stringify(body)).toContain('agents:CreateAgent');
    expect(creates()).toHaveLength(0);
  });

  test('a property carrying an action the deployer does not hold is refused', async () => {
    const body = await deployAsUser({
      Chan: {
        type: 'test_channel',
        properties: { name: 'A', kind: 'x', agent_id: 'agt_someone_elses' },
      },
    });

    expect(body.status).toBe('failed');
    expect(JSON.stringify(body)).toContain('agents:CreateAgentGeneration');
    expect(creates()).toHaveLength(0);
  });

  test('a deployer holding every declared action reaches the handler', async () => {
    const body = await deployAsUser(template.resources);

    expect(body.status).toBe('active');
    expect(creates()).toHaveLength(1);
  });

  describe('a property carrying actions keyed by its value', () => {
    beforeEach(() => {
      unregisterFormationResourceTypes({ names: ['test_channel'] });
      const registration = handler.registration({ capabilities: ['validate'] });
      registerFormationResourceTypes({
        registrations: [
          {
            ...registration,
            writer: {
              ...registration.writer,
              carries: [
                {
                  property: 'kind',
                  byValue: new Map([
                    [
                      'held',
                      [
                        {
                          action: 'test-channels:UpdateTestChannel',
                          resourceType: 'test_channel',
                        },
                      ],
                    ],
                    [
                      'unheld',
                      [{ action: 'agents:GetAgent', resourceType: 'agent' }],
                    ],
                    [
                      'project',
                      [{ action: 'projects:GetProject', resourceType: '*' }],
                    ],
                  ]),
                },
              ],
            },
          },
        ],
      });
    });

    const deployKind = (kind: string) => {
      return deployAsUser({
        Chan: { type: 'test_channel', properties: { name: 'A', kind } },
      });
    };

    test('a deployer without the keyed action is refused', async () => {
      const body = await deployKind('unheld');

      expect(body.status).toBe('failed');
      expect(JSON.stringify(body)).toContain('ACTION_NOT_HELD');
      expect(JSON.stringify(body)).toContain('agents:GetAgent');
      expect(creates()).toHaveLength(0);
    });

    test('a deployer without a keyed project-wide action is refused', async () => {
      const body = await deployKind('project');

      expect(body.status).toBe('failed');
      expect(JSON.stringify(body)).toContain('ACTION_NOT_HELD');
      expect(JSON.stringify(body)).toContain(
        `projects:GetProject on srn:${projectId}:*:*`
      );
      expect(creates()).toHaveLength(0);
    });

    test('a deployer holding the keyed action reaches the handler', async () => {
      const body = await deployKind('held');

      expect(body.status).toBe('active');
      expect(creates()).toHaveLength(1);
    });

    test('a value the declaration does not key is refused', async () => {
      const body = await deployKind('x');

      expect(body.status).toBe('failed');
      expect(JSON.stringify(body)).toContain('VALIDATION_FAILED');
      expect(creates()).toHaveLength(0);
    });
  });
});
