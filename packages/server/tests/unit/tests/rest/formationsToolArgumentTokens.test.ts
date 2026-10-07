import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// `${body.*}` in a tool's `sub` is a tool argument, filled at call time — not a
// template parameter the deploy must be given.

let adminToken: string;
let projectId: string;

const template = {
  resources: {
    ReadDoc: {
      type: 'tool',
      properties: {
        name: 'read_doc',
        type: 'http',
        execute: {
          url: { sub: 'https://docs.example.com/${body.page}' },
          method: 'GET',
        },
        parameters: {
          type: 'object',
          required: ['page'],
          properties: { page: { type: 'string' } },
        },
      },
    },
  },
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmbody',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
});

describe('POST /api/v1/formations', () => {
  test('a ${body.*} tool argument is not a missing parameter', async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({ project_id: projectId, name: 'body-token-create', template });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });
});

describe('PUT /api/v1/formations/:formation_id', () => {
  test('a ${body.*} tool argument is not a missing parameter', async () => {
    const created = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'body-token-update',
        template: {
          resources: {},
        },
      });
    expect(created.status).toBe(201);

    const res = await authenticatedTestClient(adminToken)
      .put(`/api/v1/formations/${created.body.id}`)
      .send({ template });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });
});

describe('POST /api/v1/formations/validate', () => {
  test('a ${body.*} tool argument is not reported missing when parameters are given', async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations/validate')
      .send({ template, parameters: {} });

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.valid).toBe(true);
  });
});
