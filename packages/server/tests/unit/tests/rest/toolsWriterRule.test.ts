import {
  registerMcpTools,
  unregisterMcpTools,
} from 'src/lib/mcpToolRegistrations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Whoever writes a tool holds what calling it performs: a `builtin` tool's
 * runtime actions; an `mcp` tool on a registered server, what the server
 * declares for each of its `actions`. Every write path, REST and formation.
 */
const SERVICE_URL = 'https://svc.example/mcp';

let adminToken: string;
let userToken: string;
let projectId: string;
let counter = 0;

const user = () => {
  return authenticatedTestClient(userToken);
};

const name = () => {
  counter += 1;
  return `wr-tool-${String(counter)}`;
};

const createTool = (body: Record<string, unknown>) => {
  return user()
    .post('/api/v1/tools')
    .send({ project_id: projectId, name: name(), ...body });
};

const serviceTool = (actions?: unknown) => {
  return {
    type: 'mcp',
    mcp: { url: SERVICE_URL },
    ...(actions === undefined ? {} : { actions }),
  };
};

const expectNotHeld = (
  res: { status: number; body: { error: Record<string, unknown> } },
  action: string
) => {
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('ACTION_NOT_HELD');
  expect(res.body.error.meta).toEqual({
    action,
    resource: expect.stringContaining(`srn:${projectId}:`),
  });
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'toolwriter',
    policyActions: [
      'tools:CreateTool',
      'tools:UpdateTool',
      'tools:GetTool',
      'agents:ListAgents',
      'formations:CreateFormation',
      'formations:GetFormation',
    ],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  projectId = setup.projectId;
  registerMcpTools({
    registrations: [
      {
        url: SERVICE_URL,
        tools: new Map([
          [
            'list-agents',
            [{ action: 'agents:ListAgents', resourceType: 'agent' }],
          ],
          [
            'list-secrets',
            [{ action: 'secrets:ListSecrets', resourceType: 'secret' }],
          ],
        ]),
      },
    ],
  });
});

afterAll(() => {
  unregisterMcpTools({ urls: [SERVICE_URL] });
});

describe('a builtin tool', () => {
  test('is written by a caller holding each of its actions', async () => {
    const res = await createTool({ type: 'builtin', actions: ['list-agents'] });
    expect(res.status).toBe(201);
  });

  test('is refused to a caller missing one', async () => {
    const res = await createTool({
      type: 'builtin',
      actions: ['list-agents', 'list-secrets'],
    });
    expectNotHeld(res, 'secrets:ListSecrets');
  });

  test('an edit adding an action the caller does not hold is refused', async () => {
    const created = await createTool({
      type: 'builtin',
      actions: ['list-agents'],
    });
    expect(created.status).toBe(201);
    const res = await user()
      .patch(`/api/v1/tools/${created.body.id}`)
      .send({ actions: ['list-agents', 'list-secrets'] });
    expectNotHeld(res, 'secrets:ListSecrets');
  });
});

/**
 * Actions of a multi-type module whose route authorizes on a type other than
 * the module's first: the writer holds each on its route's type.
 */
const ROUTE_TYPED_ACTIONS = [
  ['list-decisions', 'deciders:ListDecisions', 'decider', 'decision'],
  [
    'create-inline-decision',
    'deciders:CreateInlineDecision',
    'decider',
    'decision',
  ],
  ['list-datasets', 'evaluations:ListDatasets', 'eval', 'dataset'],
  ['create-dataset', 'evaluations:CreateDataset', 'eval', 'dataset'],
  ['list-memory-rules', 'memories:ListMemoryRules', 'memory', 'memory_store'],
  ['list-memory-stores', 'memories:ListMemoryStores', 'memory', 'memory_store'],
  [
    'create-memory-store',
    'memories:CreateMemoryStore',
    'memory',
    'memory_store',
  ],
  [
    'list-playbook-cases',
    'playbooks:ListPlaybookCases',
    'playbook',
    'playbook_case',
  ],
  ['list-sessions', 'agents:ListSessions', 'agent', 'session'],
  ['create-session', 'agents:CreateSession', 'agent', 'session'],
  [
    'get-trigger-firing',
    'triggers:GetTriggerFiring',
    'trigger',
    'triggerFiring',
  ],
] as const;

describe('a builtin action is held on the type its route authorizes on', () => {
  let onModuleType: string;
  let onRouteType: string;

  const principal = async (args: { username: string; type: 2 | 3 }) => {
    const admin = authenticatedTestClient(adminToken);
    const created = await admin
      .post('/api/v1/users')
      .send({ username: args.username, password: 'supersecret' });
    const policy = await admin.post('/api/v1/policies').send({
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['tools:CreateTool'],
            resource: [`srn:${projectId}:*:*`],
          },
          ...ROUTE_TYPED_ACTIONS.map((entry) => {
            return {
              effect: 'Allow',
              action: [entry[1]],
              resource: [`srn:${projectId}:${entry[args.type]}:*`],
            };
          }),
        ],
      },
    });
    expect(policy.status).toBe(201);
    await admin
      .put(`/api/v1/users/${created.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    return loginAs(args.username, 'supersecret');
  };

  const write = (token: string, action: string) => {
    return authenticatedTestClient(token)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: name(),
        type: 'builtin',
        actions: [action],
      });
  };

  beforeAll(async () => {
    onModuleType = await principal({ username: 'wrmoduletype', type: 2 });
    onRouteType = await principal({ username: 'wrroutetype', type: 3 });
  });

  test.each(ROUTE_TYPED_ACTIONS)(
    '%s is refused to a writer holding %s on %s only',
    async (action, iamAction, _moduleType, routeType) => {
      const res = await write(onModuleType, action);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        code: 'ACTION_NOT_HELD',
        meta: {
          action: iamAction,
          resource: `srn:${projectId}:${routeType}:*`,
        },
      });
    }
  );

  test.each(ROUTE_TYPED_ACTIONS)(
    '%s is written by a writer holding %s on its route type',
    async (action) => {
      const res = await write(onRouteType, action);
      expect(res.status).toBe(201);
    }
  );

  test('an action declaring no type is refused, even to the admin', async () => {
    const res = await write(adminToken, 'check-iam-permission');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('declares no resource type');
  });

  test('revoke-iam-principal is not a builtin action an agent may carry', async () => {
    const res = await write(adminToken, 'revoke-iam-principal');
    expect(res.status).toBe(400);
  });
});

describe('a pipeline tool', () => {
  const pipeline = (actions: string[]) => {
    return {
      type: 'pipeline',
      pipeline: {
        steps: [
          {
            id: 'read',
            tool: { name: 'inline', type: 'builtin', actions },
            action: actions[0],
            input: {},
          },
        ],
      },
    };
  };

  test("is written by a caller holding each step's actions", async () => {
    const res = await createTool(pipeline(['list-agents']));
    expect(res.status).toBe(201);
  });

  test("is refused to a caller missing an inline step's action", async () => {
    const res = await createTool(pipeline(['list-secrets']));
    expectNotHeld(res, 'secrets:ListSecrets');
  });
});

describe('an mcp tool on a registered server', () => {
  test('is written by a caller holding what each of its actions declares', async () => {
    const res = await createTool(serviceTool(['list-agents']));
    expect(res.status).toBe(201);
  });

  test('is refused to a caller missing a declared action', async () => {
    const res = await createTool(serviceTool(['list-secrets']));
    expectNotHeld(res, 'secrets:ListSecrets');
  });

  test('naming a tool the server does not declare fails closed', async () => {
    const res = await createTool(serviceTool(['drop-everything']));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('`drop-everything` is not a tool');
  });

  test('listing no actions fails closed', async () => {
    const res = await createTool(serviceTool());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('must list its `actions`');
  });

  test('an edit pointing an existing tool at the server is checked', async () => {
    const created = await createTool({
      type: 'mcp',
      mcp: { url: 'https://elsewhere.example/mcp' },
      actions: ['list-secrets'],
    });
    expect(created.status).toBe(201);
    const res = await user()
      .patch(`/api/v1/tools/${created.body.id}`)
      .send({ mcp: { url: `${SERVICE_URL}/` } });
    expectNotHeld(res, 'secrets:ListSecrets');
  });
});

describe('a tool deployed by a formation', () => {
  const deploy = (
    actions: unknown,
    parameters: Record<string, string> = {}
  ) => {
    return user()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: name(),
        parameters,
        template: {
          parameters: { Action: { type: 'string' } },
          resources: {
            Svc: {
              type: 'tool',
              properties: { name: name(), ...serviceTool(actions) },
            },
          },
        },
      });
  };

  test('is checked on its literal actions', async () => {
    const res = await deploy(['list-secrets'], { Action: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
    expect(JSON.stringify(res.body)).toContain('secrets:ListSecrets');
  });

  test('is checked on its actions after resolution', async () => {
    const held = await deploy([{ param: 'Action' }], { Action: 'list-agents' });
    expect(held.status).toBe(201);
    expect(held.body.status).toBe('active');

    const refused = await deploy([{ param: 'Action' }], {
      Action: 'list-secrets',
    });
    expect(refused.status).toBe(201);
    expect(refused.body.status).toBe('failed');
    expect(JSON.stringify(refused.body)).toContain('secrets:ListSecrets');
  });

  test('the admin, holding everything, deploys it', async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: name(),
        template: {
          resources: {
            Svc: {
              type: 'tool',
              properties: { name: name(), ...serviceTool(['list-secrets']) },
            },
          },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });
});
