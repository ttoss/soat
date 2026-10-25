import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// An output resolves to a string or the deploy drops it, so the write refuses
// every output value that is not a string or a single expression.

let adminToken: string;
let projectId: string;

const client = () => {
  return authenticatedTestClient(adminToken);
};

const templateWithOutputs = (outputs: Record<string, unknown>) => {
  return {
    parameters: { Suffix: { type: 'string', default: 'x' } },
    resources: {
      Store: {
        type: 'memory_store',
        properties: { name: 'fmout-store' },
      },
    },
    outputs,
  };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmout',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
});

describe('POST /api/v1/formations/validate — output value shapes', () => {
  test('accepts a string and each single expression', async () => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({
        template: templateWithOutputs({
          literal: 'plain',
          storeId: { ref: 'Store' },
          suffix: { param: 'Suffix' },
          label: { sub: 'store-${Suffix}' },
          storeName: { ref_attr: 'Store.name' },
        }),
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, errors: [], warnings: [] });
  });

  test.each([
    ['an object wrapping an expression', { value: { ref: 'Store' } }],
    ['an object literal', { x: 1 }],
    ['an expression with a sibling key', { ref: 'Store', extra: 'y' }],
    ['a number', 5],
    ['a boolean', true],
    ['an array', [{ ref: 'Store' }]],
    ['null', null],
  ])('refuses %s', async (_label, value) => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({
        template: templateWithOutputs({ plain: { ref: 'Store' }, bad: value }),
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([
      {
        path: 'outputs.bad',
        message: expect.stringContaining('must be a string or one of'),
      },
    ]);
  });
});

describe('POST /api/v1/formations — output value shapes', () => {
  test('refuses an output that cannot resolve to a string with 400', async () => {
    const res = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'fmout-refused',
        template: templateWithOutputs({
          plain: { ref: 'Store' },
          wrapped: { value: { ref: 'Store' } },
        }),
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('resolves every accepted output shape', async () => {
    const res = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'fmout-accepted',
        template: templateWithOutputs({
          literal: 'plain',
          storeId: { ref: 'Store' },
          suffix: { param: 'Suffix' },
          label: { sub: 'store-${Suffix}' },
        }),
      });

    expect(res.status).toBe(201);
    expect(res.body.outputs).toEqual({
      literal: 'plain',
      storeId: expect.any(String),
      suffix: 'x',
      label: 'store-x',
    });
  });
});
