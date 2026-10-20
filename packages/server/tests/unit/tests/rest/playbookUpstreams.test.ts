import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/** A company's profile, filled once and read by every month's DRE. */
const COMPANY = {
  nodes: [
    {
      id: 'profile',
      title: 'Company profile',
      kind: 'collect',
      final: true,
      inputs: [
        {
          name: 'cnpj',
          schema: { type: 'string' },
          required: true,
          description: 'The company CNPJ',
          source: 'manual',
        },
        {
          name: 'regime',
          schema: { type: 'string' },
          required: true,
          source: 'manual',
        },
      ],
    },
  ],
};

const dreDefinition = (companyId: string) => {
  return {
    upstreams: [{ name: 'company', playbook_id: companyId }],
    nodes: [
      {
        id: 'company',
        title: 'Company',
        kind: 'upstream',
        upstream: { name: 'company', node_id: 'profile' },
        inputs: [],
      },
      {
        id: 'revenue',
        title: 'Monthly revenue',
        kind: 'collect',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
      },
      {
        id: 'dre',
        title: 'DRE',
        kind: 'collect',
        final: true,
        inputs: [
          {
            name: 'regime',
            schema: { type: 'string' },
            required: true,
            source: { node_id: 'company', field: 'output.regime' },
          },
          {
            name: 'revenue',
            schema: { type: 'number' },
            required: true,
            source: { node_id: 'revenue', field: 'output.amount' },
          },
        ],
      },
    ],
  };
};

type CaseNode = {
  id: string;
  state: string;
  blocked_by: string[];
  output: { value: unknown; revision: number } | null;
};

type CaseBody = {
  id: string;
  upstreams: Record<string, string>;
  nodes: CaseNode[];
};

describe('Playbook upstreams', () => {
  let adminToken: string;
  let userToken: string;
  let readerToken: string;
  let projectId: string;
  let otherProjectId: string;
  let companyId: string;
  let dreId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createPlaybook = (definition: unknown, project = projectId) => {
    return admin()
      .post('/api/v1/playbooks')
      .send({ project_id: project, name: unique('playbook'), definition });
  };

  const newPlaybook = async (definition: unknown): Promise<string> => {
    const res = await createPlaybook(definition);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const newCase = async (
    playbookId: string,
    body: Record<string, unknown> = {}
  ): Promise<CaseBody> => {
    const res = await admin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: unique('case'), ...body });
    expect(res.status).toBe(201);
    // The first pull runs as an execution of the new case.
    await flushPlaybookExecutions();
    return res.body as CaseBody;
  };

  const getCase = async (caseId: string): Promise<CaseBody> => {
    const res = await admin().get(`/api/v1/playbook-cases/${caseId}`);
    expect(res.status).toBe(200);
    return res.body as CaseBody;
  };

  const writeInputs = async (
    caseId: string,
    inputs: { node_id: string; name: string; value: unknown }[]
  ): Promise<CaseBody> => {
    const current = await getCase(caseId);
    const res = await admin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        wait: true,
        inputs: inputs.map((input) => {
          const node = current.nodes.find((candidate) => {
            return candidate.id === input.node_id;
          }) as CaseNode & {
            inputs: { name: string; revision: number | null }[];
          };
          const read = node.inputs.find((candidate) => {
            return candidate.name === input.name;
          });
          return { ...input, expected_revision: read?.revision ?? null };
        }),
      });
    expect(res.status).toBe(200);
    // `wait` covers this case; a dependent it wakes runs in the same drain.
    await flushPlaybookExecutions();
    return res.body as CaseBody;
  };

  const nodeOf = (body: CaseBody, key: string): CaseNode => {
    return body.nodes.find((node) => {
      return node.id === key;
    })!;
  };

  /** A company case with its profile filled. */
  const filledCompany = async (regime = 'simples') => {
    const company = await newCase(companyId);
    return writeInputs(company.id, [
      { node_id: 'profile', name: 'cnpj', value: '12345678000190' },
      { node_id: 'profile', name: 'regime', value: regime },
    ]);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookupstreams',
      policyActions: ['playbooks:CreatePlaybookCase'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    readerToken = await createScopedPrincipal({
      adminToken,
      projectId: setup.projectId,
      username: 'playbookupstreamsreader',
      actions: ['playbooks:GetPlaybookCase'],
    });
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    companyId = await newPlaybook(COMPANY);
    dreId = await newPlaybook(dreDefinition(companyId));
  });

  describe('POST /api/v1/playbooks', () => {
    test('stores the declared upstreams with the definition', async () => {
      const res = await admin().get(`/api/v1/playbooks/${dreId}`);
      expect(res.status).toBe(200);
      expect(res.body.definition.upstreams).toEqual([
        { name: 'company', playbook_id: companyId },
      ]);
      expect(res.body.definition.nodes[0]).toMatchObject({
        id: 'company',
        kind: 'upstream',
        upstream: { name: 'company', node_id: 'profile' },
      });
    });

    test('a playbook that names no playbook of the project is UNKNOWN_UPSTREAM', async () => {
      const elsewhere = await createPlaybook(COMPANY, otherProjectId);
      expect(elsewhere.status).toBe(201);

      for (const playbookId of ['pbk_doesNotExist000000', elsewhere.body.id]) {
        const res = await createPlaybook(dreDefinition(playbookId));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PLAYBOOK_VALIDATION_FAILED');
        expect(res.body.error.meta.problems).toContainEqual(
          expect.objectContaining({
            code: 'UNKNOWN_UPSTREAM',
            path: 'definition.upstreams[0].playbook_id',
          })
        );
      }
    });

    test('an upstream node naming an undeclared upstream is UNKNOWN_UPSTREAM', async () => {
      const definition = dreDefinition(companyId);
      definition.nodes[0].upstream = { name: 'supplier', node_id: 'profile' };

      const res = await createPlaybook(definition);
      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toContainEqual(
        expect.objectContaining({
          code: 'UNKNOWN_UPSTREAM',
          path: 'definition.nodes[0].upstream.name',
        })
      );
    });

    test("an upstream node naming a node the upstream's current version lacks is MISSING_NODE", async () => {
      const definition = dreDefinition(companyId);
      definition.nodes[0].upstream = { name: 'company', node_id: 'nope' };

      const res = await createPlaybook(definition);
      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toContainEqual(
        expect.objectContaining({
          code: 'MISSING_NODE',
          path: 'definition.nodes[0].upstream.node_id',
        })
      );
    });

    test('an input reading a field the upstream node does not produce is UNKNOWN_FIELD', async () => {
      const definition = dreDefinition(companyId);
      definition.nodes[2].inputs[0].source = {
        node_id: 'company',
        field: 'output.sector',
      };

      const res = await createPlaybook(definition);
      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toContainEqual(
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: 'definition.nodes[2].inputs[0].source.field',
        })
      );
    });

    test('an upstream declared twice is DUPLICATE_UPSTREAM', async () => {
      const definition = {
        ...dreDefinition(companyId),
        upstreams: [
          { name: 'company', playbook_id: companyId },
          { name: 'company', playbook_id: companyId },
        ],
      };

      const res = await createPlaybook(definition);
      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toContainEqual(
        expect.objectContaining({
          code: 'DUPLICATE_UPSTREAM',
          path: 'definition.upstreams[1].name',
        })
      );
    });

    test('an upstream node without an upstream is 400 VALIDATION_FAILED', async () => {
      const definition = dreDefinition(companyId);
      const { upstream: _upstream, ...node } = definition.nodes[0];

      const res = await createPlaybook({
        ...definition,
        nodes: [node, ...definition.nodes.slice(1)],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an upstream node with inputs is 400 VALIDATION_FAILED', async () => {
      const definition = dreDefinition(companyId);
      const res = await createPlaybook({
        ...definition,
        nodes: [
          { ...definition.nodes[0], inputs: definition.nodes[1].inputs },
          ...definition.nodes.slice(1),
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /api/v1/playbooks/{playbook_id}', () => {
    test('a definition that would read itself through its upstreams is UPSTREAM_CYCLE', async () => {
      const first = await newPlaybook(COMPANY);
      const second = await newPlaybook(dreDefinition(first));

      const res = await admin()
        .patch(`/api/v1/playbooks/${first}`)
        .send({
          definition: {
            ...COMPANY,
            upstreams: [{ name: 'dre', playbook_id: second }],
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.meta.problems).toContainEqual(
        expect.objectContaining({
          code: 'UPSTREAM_CYCLE',
          path: 'definition.upstreams[0].playbook_id',
        })
      );
    });
  });

  describe('DELETE /api/v1/playbooks/{playbook_id}', () => {
    test('a playbook another declares as an upstream is 409 PLAYBOOK_HAS_DEPENDENTS', async () => {
      const upstream = await newPlaybook(COMPANY);
      const dependent = await newPlaybook(dreDefinition(upstream));

      const res = await admin().delete(`/api/v1/playbooks/${upstream}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_HAS_DEPENDENTS');
      expect(res.body.error.meta).toEqual({ playbooks: [dependent] });
    });

    test('once no playbook declares it, it deletes', async () => {
      const upstream = await newPlaybook(COMPANY);
      const dependent = await newPlaybook(dreDefinition(upstream));
      expect(
        (await admin().delete(`/api/v1/playbooks/${dependent}`)).status
      ).toBe(204);

      const res = await admin().delete(`/api/v1/playbooks/${upstream}`);
      expect(res.status).toBe(204);
    });
  });

  describe('POST /api/v1/playbooks/{playbook_id}/cases', () => {
    test('binds the upstream case and pulls its node at create', async () => {
      const company = await filledCompany();

      const dre = await newCase(dreId, { upstreams: { company: company.id } });
      expect(dre.upstreams).toEqual({ company: company.id });

      const read = await getCase(dre.id);
      expect(nodeOf(read, 'company')).toMatchObject({
        state: 'done',
        output: {
          value: { cnpj: '12345678000190', regime: 'simples' },
        },
      });
    });

    test('later nodes read the pulled output by field', async () => {
      const company = await filledCompany('presumido');
      const dre = await newCase(dreId, { upstreams: { company: company.id } });

      const filled = await writeInputs(dre.id, [
        { node_id: 'revenue', name: 'amount', value: 1000 },
      ]);
      expect(nodeOf(filled, 'dre')).toMatchObject({
        state: 'done',
        output: { value: { regime: 'presumido', revenue: 1000 } },
      });
    });

    test('many cases share one upstream case', async () => {
      const company = await filledCompany();
      const august = await newCase(dreId, {
        upstreams: { company: company.id },
      });
      const september = await newCase(dreId, {
        upstreams: { company: company.id },
      });

      for (const id of [august.id, september.id]) {
        expect(nodeOf(await getCase(id), 'company').state).toBe('done');
      }
    });

    test('an upstream not yet done blocks the node, and its first done wakes it', async () => {
      const company = await newCase(companyId);
      const dre = await newCase(dreId, { upstreams: { company: company.id } });
      expect(nodeOf(dre, 'company')).toMatchObject({
        state: 'blocked',
        blocked_by: ['company.profile'],
        output: null,
      });

      await writeInputs(company.id, [
        { node_id: 'profile', name: 'cnpj', value: '1' },
        { node_id: 'profile', name: 'regime', value: 'real' },
      ]);

      expect(nodeOf(await getCase(dre.id), 'company')).toMatchObject({
        state: 'done',
        output: { value: { cnpj: '1', regime: 'real' } },
      });
    });

    test('a case of a playbook with no upstreams binds none', async () => {
      const company = await newCase(companyId);
      expect(company.upstreams).toEqual({});
    });

    test.each([
      [
        'an upstream left unbound',
        () => {
          return {};
        },
      ],
      [
        'an undeclared name',
        (id: string) => {
          return { company: id, supplier: id };
        },
      ],
      [
        'an unknown case',
        () => {
          return { company: 'pbk_case_doesNotExist0000' };
        },
      ],
      [
        'a value that is not a case id',
        () => {
          return { company: 42 };
        },
      ],
      [
        'upstreams that are not an object',
        () => {
          return 'company';
        },
      ],
    ])('%s is 400 PLAYBOOK_CASE_UPSTREAM_INVALID', async (_label, bind) => {
      const company = await filledCompany();

      const res = await admin()
        .post(`/api/v1/playbooks/${dreId}/cases`)
        .send({ subject: unique('case'), upstreams: bind(company.id) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_UPSTREAM_INVALID');
    });

    test('a case of another playbook is 400 PLAYBOOK_CASE_UPSTREAM_INVALID', async () => {
      const other = await newPlaybook(COMPANY);
      const wrong = await newCase(other);

      const res = await admin()
        .post(`/api/v1/playbooks/${dreId}/cases`)
        .send({ subject: unique('case'), upstreams: { company: wrong.id } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_UPSTREAM_INVALID');
      expect(res.body.error.meta).toEqual({
        upstream: 'company',
        case_id: wrong.id,
      });
    });

    test('a case of another actor is 400 PLAYBOOK_CASE_UPSTREAM_INVALID', async () => {
      const actor = await admin()
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: unique('actor') });
      expect(actor.status).toBe(201);
      const company = await filledCompany();

      const res = await admin()
        .post(`/api/v1/playbooks/${dreId}/cases`)
        .send({
          subject: unique('case'),
          actor_id: actor.body.id,
          upstreams: { company: company.id },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_UPSTREAM_INVALID');
    });

    test('the same actor binds', async () => {
      const actor = await admin()
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: unique('actor') });
      const company = await newCase(companyId, { actor_id: actor.body.id });

      const dre = await newCase(dreId, {
        actor_id: actor.body.id,
        upstreams: { company: company.id },
      });
      expect(dre.upstreams).toEqual({ company: company.id });
    });

    test('a caller who may not read the upstream case is 400, as if it did not exist', async () => {
      const company = await filledCompany();

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbooks/${dreId}/cases`)
        .send({ subject: unique('case'), upstreams: { company: company.id } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_UPSTREAM_INVALID');
    });

    test('a caller without CreatePlaybookCase is 403', async () => {
      const company = await filledCompany();

      const res = await authenticatedTestClient(readerToken)
        .post(`/api/v1/playbooks/${dreId}/cases`)
        .send({ subject: unique('case'), upstreams: { company: company.id } });
      expect(res.status).toBe(403);
    });

    test('no credential is 401', async () => {
      const res = await testClient
        .post(`/api/v1/playbooks/${dreId}/cases`)
        .send({ subject: 'anon', upstreams: {} });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/playbook-cases', () => {
    test('a listed case carries its bindings', async () => {
      const company = await filledCompany();
      const dre = await newCase(dreId, { upstreams: { company: company.id } });

      const res = await admin().get(
        `/api/v1/playbook-cases?playbook_id=${dreId}`
      );
      expect(res.status).toBe(200);
      const listed = res.body.data.find((row: { id: string }) => {
        return row.id === dre.id;
      });
      expect(listed.upstreams).toEqual({ company: company.id });
    });
  });

  describe('an upstream change', () => {
    const changedCompany = async () => {
      const company = await filledCompany('simples');
      const dre = await newCase(dreId, { upstreams: { company: company.id } });
      const closed = await writeInputs(dre.id, [
        { node_id: 'revenue', name: 'amount', value: 500 },
      ]);
      await writeInputs(company.id, [
        { node_id: 'profile', name: 'regime', value: 'real' },
      ]);
      return { company, dre, closed };
    };

    test('makes the upstream node stale and runs nothing in the dependent', async () => {
      const { dre, closed } = await changedCompany();

      const read = await getCase(dre.id);
      expect(nodeOf(read, 'company')).toMatchObject({
        state: 'stale',
        output: { value: { cnpj: '12345678000190', regime: 'simples' } },
      });
      expect(nodeOf(read, 'dre').output).toEqual(nodeOf(closed, 'dre').output);
      expect(
        read.nodes.map((node) => {
          return node.state;
        })
      ).not.toContain('running');
    });

    test('POST nodes/{node}/run refreshes it and the dependent cascade proceeds', async () => {
      const { dre } = await changedCompany();

      const run = await admin()
        .post(`/api/v1/playbook-cases/${dre.id}/nodes/company/run`)
        .send({ wait: true });
      expect(run.status).toBe(201);
      expect(run.body).toMatchObject({
        node_id: 'company',
        status: 'completed',
        executor: null,
      });

      await flushPlaybookExecutions();

      const read = await getCase(dre.id);
      expect(nodeOf(read, 'company')).toMatchObject({
        state: 'done',
        output: { value: { regime: 'real' } },
      });
      expect(nodeOf(read, 'dre')).toMatchObject({
        state: 'done',
        output: { value: { regime: 'real', revenue: 500 } },
      });
    });
  });

  describe('an upstream case upgrade', () => {
    test('the dependent follows it, and a pulled node it removes reads blocked', async () => {
      const upstream = await newPlaybook(COMPANY);
      const dependent = await newPlaybook(dreDefinition(upstream));
      const company = await newCase(upstream);
      await writeInputs(company.id, [
        { node_id: 'profile', name: 'cnpj', value: '1' },
        { node_id: 'profile', name: 'regime', value: 'real' },
      ]);
      const dre = await newCase(dependent, {
        upstreams: { company: company.id },
      });
      expect(nodeOf(await getCase(dre.id), 'company').state).toBe('done');

      const renamed = {
        nodes: [{ ...COMPANY.nodes[0], id: 'identity' }],
      };
      expect(
        (
          await admin()
            .patch(`/api/v1/playbooks/${upstream}`)
            .send({ definition: renamed })
        ).status
      ).toBe(200);

      const upgraded = await admin()
        .post(`/api/v1/playbook-cases/${company.id}/upgrade`)
        .send({ version: 2 });
      expect(upgraded.status).toBe(200);

      expect(nodeOf(await getCase(dre.id), 'company')).toMatchObject({
        state: 'blocked',
        blocked_by: ['company.profile'],
      });
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/run', () => {
    test('an upstream node whose upstream is not done is 409 PLAYBOOK_NODE_NOT_RUNNABLE', async () => {
      const company = await newCase(companyId);
      const dre = await newCase(dreId, { upstreams: { company: company.id } });

      const res = await admin()
        .post(`/api/v1/playbook-cases/${dre.id}/nodes/company/run`)
        .send({ wait: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_NODE_NOT_RUNNABLE');
      expect(res.body.error.meta.blocked_by).toEqual(['company.profile']);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/missing', () => {
    test("lists the bound case's missing inputs with its case_id", async () => {
      const company = await newCase(companyId);
      const dre = await newCase(dreId, { upstreams: { company: company.id } });

      const res = await admin().get(
        `/api/v1/playbook-cases/${dre.id}/missing?node_id=dre`
      );
      expect(res.status).toBe(200);
      const missing = res.body.waves.flat();
      expect(missing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            case_id: company.id,
            node_id: 'profile',
            input: 'cnpj',
            description: 'The company CNPJ',
          }),
          expect.objectContaining({
            case_id: company.id,
            node_id: 'profile',
            input: 'regime',
          }),
          expect.objectContaining({
            case_id: dre.id,
            node_id: 'revenue',
            input: 'amount',
          }),
        ])
      );
      expect(missing).toHaveLength(3);
    });
  });

  describe('DELETE /api/v1/playbook-cases/{case_id}', () => {
    test('a case another case is bound to is 409 PLAYBOOK_CASE_HAS_DEPENDENTS', async () => {
      const company = await filledCompany();
      const dre = await newCase(dreId, { upstreams: { company: company.id } });

      const res = await admin().delete(`/api/v1/playbook-cases/${company.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_HAS_DEPENDENTS');
      expect(res.body.error.meta).toEqual({ cases: [dre.id] });
    });

    test('deleting the dependent first frees the upstream case', async () => {
      const company = await filledCompany();
      const dre = await newCase(dreId, { upstreams: { company: company.id } });

      expect(
        (await admin().delete(`/api/v1/playbook-cases/${dre.id}`)).status
      ).toBe(204);
      expect(
        (await admin().delete(`/api/v1/playbook-cases/${company.id}`)).status
      ).toBe(204);
    });
  });
});
