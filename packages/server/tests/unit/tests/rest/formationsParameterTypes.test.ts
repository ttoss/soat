import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A deploy-time parameter value arrives as a string and takes the declared
 * `type`: a guard reading a `number` compares numbers and one reading a `list`
 * tests membership, not a substring.
 */
describe('Formation parameter types', () => {
  let userToken: string;
  let projectId: string;
  let formationSeq = 0;

  const parameters = {
    LimitN: { type: 'number', default: 3 },
    Paths: { type: 'list', default: ['.github/', 'CLAUDE.md'] },
    Label: { type: 'string', default: 'flow' },
  };

  const template = {
    parameters,
    resources: {
      Flow: {
        type: 'workflow',
        properties: {
          name: { sub: 'typed-${Label}' },
          states: [
            { name: 'todo', initial: true, kind: 'human' },
            { name: 'done', terminal: true },
          ],
          transitions: [
            {
              name: 'finish',
              from: ['todo'],
              to: 'done',
              guard: {
                and: [
                  {
                    '<': [{ var: 'task.payload.rounds' }, { param: 'LimitN' }],
                  },
                  { in: [{ var: 'task.payload.path' }, { param: 'Paths' }] },
                ],
              },
            },
          ],
        },
      },
    },
  };

  const guardOf = (properties: { transitions: { guard: unknown }[] }) => {
    return properties.transitions[0].guard;
  };

  const plan = (body: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/formations/plan')
      .send({ project_id: projectId, template, ...body });
  };

  const create = (body: Record<string, unknown>) => {
    formationSeq += 1;
    return authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: `typed-params-${formationSeq}`,
        template,
        ...body,
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fparamtypes',
      policyActions: [
        'formations:ValidateFormation',
        'formations:PlanFormation',
        'formations:CreateFormation',
        'formations:GetFormation',
        'formations:UpdateFormation',
        'workflows:CreateWorkflow',
        'workflows:GetWorkflow',
        'workflows:UpdateWorkflow',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  test('plan resolves defaults typed', async () => {
    const res = await plan({});
    expect(res.status).toBe(200);
    expect(guardOf(res.body.changes[0].diff.desired)).toEqual({
      and: [
        { '<': [{ var: 'task.payload.rounds' }, 3] },
        { in: [{ var: 'task.payload.path' }, ['.github/', 'CLAUDE.md']] },
      ],
    });
  });

  test('plan resolves overridden number and list values typed', async () => {
    const res = await plan({
      parameters: { LimitN: '5', Paths: '["infra/"]' },
    });
    expect(res.status).toBe(200);
    expect(guardOf(res.body.changes[0].diff.desired)).toEqual({
      and: [
        { '<': [{ var: 'task.payload.rounds' }, 5] },
        { in: [{ var: 'task.payload.path' }, ['infra/']] },
      ],
    });
  });

  test('a deployed guard over overridden values stores them typed', async () => {
    const res = await create({
      parameters: { LimitN: '5', Paths: '["infra/"]', Label: 'deployed' },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.resolved_parameters).toEqual({
      LimitN: '5',
      Paths: '["infra/"]',
      Label: 'deployed',
    });
    const workflow = await authenticatedTestClient(userToken).get(
      `/api/v1/workflows/${res.body.resources[0].physical_resource_id}`
    );
    expect(workflow.status).toBe(200);
    expect(workflow.body.name).toBe('typed-deployed');
    expect(guardOf(workflow.body)).toEqual({
      and: [
        { '<': [{ var: 'task.payload.rounds' }, 5] },
        { in: [{ var: 'task.payload.path' }, ['infra/']] },
      ],
    });
  });

  test('resolved_parameters records typed defaults as strings', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    expect(res.body.resolved_parameters).toEqual({
      LimitN: '3',
      Paths: '[".github/","CLAUDE.md"]',
      Label: 'flow',
    });
  });

  test.each([
    ['a non-numeric number', { LimitN: 'five' }, 'LimitN'],
    ['an empty number', { LimitN: ' ' }, 'LimitN'],
    ['a list that is not JSON', { Paths: 'infra/' }, 'Paths'],
    ['a list that is a JSON object', { Paths: '{"a":1}' }, 'Paths'],
  ])('plan refuses %s with 400', async (_label, values, name) => {
    const res = await plan({ parameters: values });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FORMATION_INVALID_PARAMETERS');
    expect(JSON.stringify(res.body)).toContain(`parameters.${name}`);
  });

  test('create refuses an unparseable value with 400 and deploys nothing', async () => {
    const res = await create({ parameters: { Paths: 'infra/' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FORMATION_INVALID_PARAMETERS');
  });

  test('update refuses an unparseable value with 400', async () => {
    const created = await create({});
    expect(created.status).toBe(201);
    const res = await authenticatedTestClient(userToken)
      .put(`/api/v1/formations/${created.body.id}`)
      .send({ template, parameters: { LimitN: 'many' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FORMATION_INVALID_PARAMETERS');
  });

  describe('PUT /api/v1/formations/:formation_id without a template', () => {
    const requiredLabel = {
      ...template,
      parameters: { ...parameters, Label: { type: 'string' } },
    };

    const redeploy = async (values: Record<string, string>) => {
      const created = await create({
        template: requiredLabel,
        parameters: { Label: 'first' },
      });
      expect(created.status).toBe(201);
      return authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${created.body.id}`)
        .send({ parameters: values });
    };

    test('redeploys the stored template with the new values', async () => {
      const res = await redeploy({ Label: 'second', LimitN: '4' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.resolved_parameters).toEqual(
        expect.objectContaining({ Label: 'second', LimitN: '4' })
      );
    });

    test('refuses a missing required parameter with 400', async () => {
      const res = await redeploy({ LimitN: '4' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
      expect(JSON.stringify(res.body)).toContain('parameters.Label');
    });

    test('refuses an unparseable value with 400', async () => {
      const res = await redeploy({ Label: 'second', LimitN: 'many' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_INVALID_PARAMETERS');
    });

    test('plan still requires a template', async () => {
      const created = await create({});
      expect(created.status).toBe(201);
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, formation_id: created.body.id });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/formations/validate', () => {
    const validate = (body: Record<string, unknown>) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send(body);
    };

    test('reports an unparseable value as an error', async () => {
      const res = await validate({ template, parameters: { LimitN: 'x' } });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'parameters.LimitN' }),
        ])
      );
    });

    test.each([
      ['an unknown type', { P: { type: 'boolean' } }, 'parameters.P.type'],
      [
        'a number default that is not a number',
        { P: { type: 'number', default: 'many' } },
        'parameters.P.default',
      ],
      [
        'a list default that is not a list',
        { P: { type: 'list', default: 'a,b' } },
        'parameters.P.default',
      ],
    ])('refuses %s', async (_label, declared, path) => {
      const res = await validate({
        template: { parameters: declared, resources: template.resources },
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })])
      );
    });
  });
});
