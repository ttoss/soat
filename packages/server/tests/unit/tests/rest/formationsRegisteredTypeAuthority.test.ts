import crypto from 'node:crypto';

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
