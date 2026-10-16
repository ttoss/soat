import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

const DEPLOY_ACTIONS = [
  'formations:*',
  'playbooks:*',
  'tools:CreateTool',
  'tools:GetTool',
  'tools:UpdateTool',
  'tools:DeleteTool',
];

type FormationResource = {
  logical_id: string;
  physical_resource_id: string;
};

/** One `execute` node calling `tool` on a manual `amount`. */
const definitionCalling = (tool: unknown) => {
  return {
    nodes: [
      {
        key: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
        executor: { type: 'tool', id: tool },
      },
    ],
  };
};

describe('Formations — playbook resources', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const resources = () => {
    return {
      Quote: {
        type: 'tool',
        properties: {
          name: unique('quote'),
          type: 'http',
          description: 'Quotes a price',
          parameters: { type: 'object', properties: {} },
          execute: { url: `${stub.baseUrl}/quote`, method: 'POST' },
        },
      },
      Pricing: {
        type: 'playbook',
        properties: {
          name: unique('pricing'),
          description: 'Prices a client',
          definition: definitionCalling({ ref: 'Quote' }),
        },
      },
    };
  };

  const deploy = (token: string, template: Record<string, unknown>) => {
    return authenticatedTestClient(token)
      .post('/api/v1/formations')
      .send({ project_id: projectId, name: unique('stack'), template });
  };

  const physicalId = (
    formation: { resources: FormationResource[] },
    logicalId: string
  ): string => {
    const resource = formation.resources.find((r) => {
      return r.logical_id === logicalId;
    });
    if (!resource) throw new Error(`No resource ${logicalId}`);
    return resource.physical_resource_id;
  };

  const getPlaybook = (id: string) => {
    return authenticatedTestClient(userToken).get(`/api/v1/playbooks/${id}`);
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/quote': () => {
          return { body: { price: 42 } };
        },
      },
    });
    const setup = await setupProjectWithUsers({
      prefix: 'formations-playbooks',
      policyActions: [...DEPLOY_ACTIONS, 'tools:CallTool'],
      createOtherProject: false,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/formations/validate', () => {
    test('a playbook naming a tool in the same template is valid', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: { resources: resources() } });

      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
      expect(res.body.valid).toBe(true);
    });

    test('a playbook field the resource does not declare is invalid', async () => {
      const declared = resources();
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              ...declared,
              Pricing: {
                type: 'playbook',
                properties: { ...declared.Pricing.properties, version: 3 },
              },
            },
          },
        });

      expect(res.body.valid).toBe(false);
    });
  });

  describe('POST /api/v1/formations', () => {
    test('deploys a playbook bound to the tool it declares', async () => {
      const res = await deploy(userToken, { resources: resources() });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      const playbook = await getPlaybook(physicalId(res.body, 'Pricing'));
      expect(playbook.status).toBe(200);
      expect(playbook.body.version).toBe(1);
      expect(playbook.body.description).toBe('Prices a client');
      expect(playbook.body.definition.nodes[0].executor).toEqual({
        type: 'tool',
        id: physicalId(res.body, 'Quote'),
      });
    });

    test('its nodes run as the credential that deployed it', async () => {
      const formation = await deploy(userToken, { resources: resources() });
      const playbookId = physicalId(formation.body, 'Pricing');
      const created = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: unique('client') });
      expect(created.status).toBe(201);

      const written = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbook-cases/${created.body.id}/inputs`)
        .send({
          inputs: [
            {
              node: 'pricing',
              name: 'amount',
              value: 10,
              expected_revision: null,
            },
          ],
        });
      expect(written.status).toBe(200);
      await flushPlaybookExecutions();

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${created.body.id}`
      );
      const node = read.body.nodes.find((each: { key: string }) => {
        return each.key === 'pricing';
      });
      expect(node.state).toBe('done');
      expect(node.output.value).toEqual({ price: 42 });
    });

    test('an API key deploys within its own boundary, not its owner’s', async () => {
      const policy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: DEPLOY_ACTIONS,
                resource: [`srn:${projectId}:*:*`],
              },
            ],
          },
        });
      expect(policy.status).toBe(201);
      const key = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: unique('deploy-key'),
          project_id: projectId,
          policy_ids: [policy.body.id],
        });
      expect(key.status).toBe(201);

      const res = await deploy(key.body.key, { resources: resources() });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.message).toBe(
        "The playbook's author may not start the tool on node 'pricing'."
      );
    });

    test('returns 403 naming the action the deployer lacks', async () => {
      const token = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'fmpbknoplaybook',
        actions: ['formations:*', 'tools:*'],
      });

      const res = await deploy(token, { resources: resources() });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Pricing',
          resource_type: 'playbook',
          action: 'playbooks:CreatePlaybook',
        },
      ]);
    });
  });

  describe('PUT /api/v1/formations/{formation_id}', () => {
    test('a changed definition archives a new version', async () => {
      const declared = resources();
      const formation = await deploy(userToken, { resources: declared });
      const changed = definitionCalling({ ref: 'Quote' });
      changed.nodes[0].title = 'Priced';

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formation.body.id}`)
        .send({
          template: {
            resources: {
              ...declared,
              Pricing: {
                type: 'playbook',
                properties: {
                  ...declared.Pricing.properties,
                  definition: changed,
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const playbook = await getPlaybook(physicalId(formation.body, 'Pricing'));
      expect(playbook.body.version).toBe(2);
      expect(playbook.body.definition.nodes[0].title).toBe('Priced');
    });
  });

  describe('DELETE /api/v1/formations/{formation_id}', () => {
    test('a playbook with cases blocks the teardown before anything is deleted', async () => {
      const formation = await deploy(userToken, { resources: resources() });
      const playbookId = physicalId(formation.body, 'Pricing');
      const created = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: unique('client') });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formation.body.id}`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FORMATION_DELETE_FAILED');
      expect(res.body.error.meta.failures).toEqual([
        expect.objectContaining({
          logical_id: 'Pricing',
          resource_type: 'playbook',
          error: `Playbook '${playbookId}' has 1 case(s) and cannot be deleted.`,
        }),
      ]);
      const tool = await authenticatedTestClient(userToken).get(
        `/api/v1/tools/${physicalId(formation.body, 'Quote')}`
      );
      expect(tool.status).toBe(200);
    });

    test('a playbook without cases is deleted with the stack', async () => {
      const formation = await deploy(userToken, { resources: resources() });
      const playbookId = physicalId(formation.body, 'Pricing');

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formation.body.id}`
      );

      expect(res.status).toBe(200);
      expect((await getPlaybook(playbookId)).status).toBe(404);
    });
  });
});
