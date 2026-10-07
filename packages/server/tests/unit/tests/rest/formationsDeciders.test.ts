import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const FORMATION_ACTIONS = [
  'formations:PlanFormation',
  'formations:ValidateFormation',
  'formations:CreateFormation',
  'formations:GetFormation',
  'formations:UpdateFormation',
  'formations:DeleteFormation',
];

const RESOURCE_ACTIONS = [
  'agents:CreateAgent',
  'agents:UpdateAgent',
  'agents:DeleteAgent',
  'agents:GetAgent',
  'tools:CreateTool',
  'tools:UpdateTool',
  'tools:DeleteTool',
  'tools:GetTool',
  'deciders:CreateDecider',
  'deciders:UpdateDecider',
  'deciders:DeleteDecider',
  'deciders:GetDecider',
];

const ROUTE = {
  type: 'choice',
  name: 'route',
  instructions: 'Which team should own this ticket?',
  choices: [
    { value: 'billing', description: 'Charges, refunds, invoices' },
    { value: 'technical', description: 'Errors, outages' },
  ],
};

const NEEDS_HUMAN = {
  type: 'predicate',
  name: 'needs_human',
  instructions: 'Must a person read this first?',
};

const QUESTIONS = [ROUTE, NEEDS_HUMAN];

type FormationResource = {
  logical_id: string;
  status: string;
  physical_resource_id: string;
};

describe('Formations — decider resources', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let providerId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const agentResource = () => {
    return {
      type: 'agent',
      properties: { ai_provider_id: providerId, name: unique('judge') },
    };
  };

  const toolResource = () => {
    return {
      type: 'tool',
      properties: {
        name: unique('engine'),
        type: 'http',
        description: 'Answers a question set',
        execute: { url: 'https://engine.example.com/decide', method: 'POST' },
      },
    };
  };

  const deciderResource = (backend: Record<string, unknown>) => {
    return {
      type: 'decider',
      properties: {
        name: unique('triage'),
        questions: QUESTIONS,
        ...backend,
      },
    };
  };

  const validate = (resources: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/formations/validate')
      .send({ template: { resources } });
  };

  const deploy = async (resources: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: unique('decider-stack'),
        template: { resources },
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; resources: FormationResource[] };
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

  const getDecider = (id: string) => {
    return authenticatedTestClient(userToken).get(`/api/v1/deciders/${id}`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'formations-deciders',
      policyActions: [...FORMATION_ACTIONS, ...RESOURCE_ACTIONS],
      createOtherProject: false,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'formations-deciders-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      });
    expect(providerRes.status).toBe(201);
    providerId = providerRes.body.id;
  });

  describe('POST /api/v1/formations/validate', () => {
    test('a decider over an agent in the same template is valid', async () => {
      const res = await validate({
        Judge: agentResource(),
        Triage: deciderResource({ agent_id: { ref: 'Judge' } }),
      });

      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
      expect(res.body.valid).toBe(true);
    });

    test('a decider naming both an agent and a tool is invalid', async () => {
      const res = await validate({
        Judge: agentResource(),
        Engine: toolResource(),
        Triage: deciderResource({
          agent_id: { ref: 'Judge' },
          tool_id: { ref: 'Engine' },
        }),
      });

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          path: 'resources.Triage.properties',
          message: expect.stringMatching(/exactly one of agent_id and tool_id/),
        }),
      ]);
    });

    test('a decider naming no backend is invalid', async () => {
      const res = await validate({ Triage: deciderResource({}) });

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/exactly one of agent_id and tool_id/),
        }),
      ]);
    });

    test('a decider with no questions is invalid', async () => {
      const res = await validate({
        Judge: agentResource(),
        Triage: {
          type: 'decider',
          properties: { name: 'triage', agent_id: { ref: 'Judge' } },
        },
      });

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          path: 'resources.Triage.properties.questions',
          message: '`questions` is required',
        }),
      ]);
    });

    test('a question with a field the contract does not declare is invalid', async () => {
      const res = await validate({
        Judge: agentResource(),
        Triage: {
          type: 'decider',
          properties: {
            name: 'triage',
            agent_id: { ref: 'Judge' },
            questions: [{ ...ROUTE, weight: 2 }],
          },
        },
      });

      expect(res.body.valid).toBe(false);
      expect(JSON.stringify(res.body.errors)).toMatch(/weight/);
    });

    test('a choice question with one choice is invalid', async () => {
      const res = await validate({
        Judge: agentResource(),
        Triage: {
          type: 'decider',
          properties: {
            name: 'triage',
            agent_id: { ref: 'Judge' },
            questions: [
              {
                type: 'choice',
                name: 'route',
                instructions: 'Which team?',
                choices: [{ value: 'billing', description: 'Charges' }],
              },
            ],
          },
        },
      });

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          path: 'resources.Triage.properties.questions',
        }),
      ]);
    });
    test('questions keyed by name instead of listed are invalid', async () => {
      const res = await validate({
        Judge: agentResource(),
        Triage: {
          type: 'decider',
          properties: {
            name: 'triage',
            agent_id: { ref: 'Judge' },
            questions: { route: ROUTE },
          },
        },
      });

      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringMatching(
              /^resources\.Triage\.properties\.questions/
            ),
          }),
        ])
      );
    });
  });

  describe('POST /api/v1/formations', () => {
    test('creates a decider over the template’s agent', async () => {
      const formation = await deploy({
        Judge: agentResource(),
        Triage: deciderResource({ agent_id: { ref: 'Judge' } }),
      });

      const deciderId = physicalId(formation, 'Triage');
      expect(deciderId).toMatch(/^dcd_/);
      const res = await getDecider(deciderId);
      expect(res.body.agent_id).toBe(physicalId(formation, 'Judge'));
      expect(res.body.tool_id).toBeNull();
      expect(res.body.questions).toEqual(QUESTIONS);
      expect(res.body.version).toBe(1);
    });

    test('creates a decider over the template’s tool', async () => {
      const formation = await deploy({
        Engine: toolResource(),
        Triage: deciderResource({ tool_id: { ref: 'Engine' } }),
      });

      const res = await getDecider(physicalId(formation, 'Triage'));
      expect(res.body.tool_id).toBe(physicalId(formation, 'Engine'));
      expect(res.body.agent_id).toBeNull();
    });

    test('a deploy token without CreateDecider is refused before anything is applied', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  ...FORMATION_ACTIONS,
                  ...RESOURCE_ACTIONS.filter((action) => {
                    return action !== 'deciders:CreateDecider';
                  }),
                ],
              },
            ],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: unique('no-create-decider'),
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const res = await authenticatedTestClient(keyRes.body.key)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('refused-stack'),
          template: {
            resources: {
              Judge: agentResource(),
              Triage: deciderResource({ agent_id: { ref: 'Judge' } }),
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Triage',
          resource_type: 'decider',
          action: 'deciders:CreateDecider',
        },
      ]);
    });
  });

  describe('POST /api/v1/formations/plan', () => {
    test('an unchanged decider plans as a no-op', async () => {
      const resources = {
        Judge: agentResource(),
        Triage: deciderResource({ agent_id: { ref: 'Judge' } }),
      };
      const formation = await deploy(resources);

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: formation.id,
          template: { resources },
        });

      expect(res.status).toBe(200);
      const change = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'Triage';
      });
      expect(change.action).toBe('no-op');
    });
  });

  describe('PUT /api/v1/formations/{formation_id}', () => {
    test('changing the questions archives a new decider version', async () => {
      const triage = deciderResource({ agent_id: { ref: 'Judge' } });
      const judge = agentResource();
      const formation = await deploy({ Judge: judge, Triage: triage });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formation.id}`)
        .send({
          template: {
            resources: {
              Judge: judge,
              Triage: {
                ...triage,
                properties: {
                  ...triage.properties,
                  questions: [NEEDS_HUMAN],
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      const decider = await getDecider(physicalId(formation, 'Triage'));
      expect(decider.body.version).toBe(2);
      expect(decider.body.questions).toEqual([NEEDS_HUMAN]);
    });

    test('pointing the decider at a tool replaces its agent', async () => {
      const triage = deciderResource({ agent_id: { ref: 'Judge' } });
      const judge = agentResource();
      const formation = await deploy({ Judge: judge, Triage: triage });
      const engine = toolResource();

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formation.id}`)
        .send({
          template: {
            resources: {
              Judge: judge,
              Engine: engine,
              Triage: {
                type: 'decider',
                properties: {
                  name: triage.properties.name,
                  questions: QUESTIONS,
                  tool_id: { ref: 'Engine' },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      const decider = await getDecider(physicalId(formation, 'Triage'));
      expect(decider.body.agent_id).toBeNull();
      expect(decider.body.tool_id).toMatch(/^tool_/);
    });
  });

  describe('DELETE /api/v1/formations/{formation_id}', () => {
    test('tears down a decider together with the agent it names', async () => {
      const formation = await deploy({
        Judge: agentResource(),
        Triage: deciderResource({ agent_id: { ref: 'Judge' } }),
      });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formation.id}`
      );

      expect(res.status).toBe(200);
      const decider = await getDecider(physicalId(formation, 'Triage'));
      expect(decider.status).toBe(404);
    });

    test('tears down a decider together with the tool it names', async () => {
      const formation = await deploy({
        Engine: toolResource(),
        Triage: deciderResource({ tool_id: { ref: 'Engine' } }),
      });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formation.id}`
      );

      expect(res.status).toBe(200);
    });

    test.each([
      ['agent', agentResource, 'agent_id'],
      ['tool', toolResource, 'tool_id'],
    ])(
      'an %s a decider outside the stack names blocks teardown before anything is deleted',
      async (_label, backendResource, field) => {
        const formation = await deploy({ Backend: backendResource() });
        const outside = await authenticatedTestClient(userToken)
          .post('/api/v1/deciders')
          .send({
            project_id: projectId,
            name: unique('outside'),
            questions: QUESTIONS,
            [field]: physicalId(formation, 'Backend'),
          });
        expect(outside.status).toBe(201);

        const res = await authenticatedTestClient(userToken).delete(
          `/api/v1/formations/${formation.id}`
        );

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FORMATION_DELETE_FAILED');
        expect(res.body.error.meta.failures).toEqual([
          expect.objectContaining({
            logical_id: 'Backend',
            error: expect.stringMatching(/decider/),
          }),
        ]);
        const read = await authenticatedTestClient(userToken).get(
          `/api/v1/formations/${formation.id}`
        );
        expect(read.body.status).toBe('active');
      }
    );
  });
});
