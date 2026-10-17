import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { pollUntil } from '../../fixtures/agentToolTurn';
import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, testClient } from '../../testClient';

const PDF = Buffer.from('%PDF-1.4 proposal');
const XLSX = Buffer.from('PK sheet');
const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const EXPORT_ACTIONS = [
  'playbooks:ExportPlaybookCaseNode',
  'playbooks:ListPlaybookCaseExports',
  'playbooks:GetPlaybookCaseExport',
];

type Transformation = { name: string; format: string; tool: string };

/** One final `collect` node_id: its output is its manual `amount`. */
const finalNode = (transformations: Transformation[]) => {
  return {
    nodes: [
      {
        id: 'pricing',
        title: 'Pricing',
        kind: 'collect',
        final: true,
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
        transformations,
      },
    ],
  };
};

describe('Playbook exports', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let readerToken: string;
  let projectId: string;
  let pdfToolId: string;
  let sheetToolId: string;
  let jsonToolId: string;
  let plainToolId: string;
  let downToolId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const newCase = async (args: {
    transformations?: Transformation[];
    token?: string;
  }): Promise<string> => {
    seq += 1;
    const playbook = await authenticatedTestClient(args.token ?? adminToken)
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: `export-${seq}`,
        definition: finalNode(
          args.transformations ?? [
            { name: 'proposal', format: 'pdf', tool: pdfToolId },
            { name: 'sheet', format: 'xlsx', tool: sheetToolId },
          ]
        ),
      });
    expect(playbook.status).toBe(201);
    const created = await asAdmin()
      .post(`/api/v1/playbooks/${playbook.body.id}/cases`)
      .send({ subject: `client-${seq}` });
    expect(created.status).toBe(201);
    return created.body.id as string;
  };

  /** Writes `amount` and lets the cascade settle the node; its revision. */
  const writeAmount = async (caseId: string, value: number) => {
    const current = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'pricing',
            name: 'amount',
            value,
            expected_revision: current.body.nodes[0].inputs[0].revision,
          },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
    const settled = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    expect(settled.body.nodes[0].state).toBe('done');
    return settled.body.nodes[0].output.revision as number;
  };

  const exportNode = (
    caseId: string,
    body: Record<string, unknown> = { wait: true },
    token = userToken
  ) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/playbook-cases/${caseId}/nodes/pricing/exports`)
      .send(body);
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/pdf': () => {
          return { body: PDF, contentType: 'application/pdf' };
        },
        '/sheet': () => {
          return { body: XLSX, contentType: XLSX_TYPE };
        },
        '/json': () => {
          return { body: { not: 'a pdf' } };
        },
        '/plain': () => {
          return { body: { rendered: true } };
        },
        '/down': () => {
          return { status: 500, body: { message: 'down' } };
        },
      },
    });

    const setup = await setupProjectWithUsers({
      prefix: 'playbookexport',
      policyActions: [
        ...EXPORT_ACTIONS,
        'playbooks:GetPlaybookCase',
        'playbooks:PausePlaybookCase',
        'files:GetFile',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    readerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'pbkexportreader',
      actions: ['playbooks:GetPlaybookCase'],
    });

    const httpTool = async (path: string, responseMode?: string) => {
      const res = await asAdmin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: `export${path.replace('/', '-')}`,
          type: 'http',
          description: 'Renders a file',
          parameters: { type: 'object', properties: {} },
          execute: {
            url: `${stub.baseUrl}${path}`,
            method: 'POST',
            ...(responseMode && { response_mode: responseMode }),
          },
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    pdfToolId = await httpTool('/pdf', 'base64');
    sheetToolId = await httpTool('/sheet', 'base64');
    jsonToolId = await httpTool('/json', 'base64');
    plainToolId = await httpTool('/plain');
    downToolId = await httpTool('/down', 'base64');
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/exports', () => {
    test('renders the latest output with every transformation', async () => {
      const caseId = await newCase({});
      const revision = await writeAmount(caseId, 7);

      const res = await exportNode(caseId);

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveLength(2);
      const [proposal, sheet] = res.body.data;
      expect(proposal).toMatchObject({
        id: expect.stringMatching(/^pbk_exp_/),
        case_id: caseId,
        node_id: 'pricing',
        revision,
        playbook_version: 1,
        transformation: 'proposal',
        format: 'pdf',
        tool_id: pdfToolId,
        status: 'completed',
        stale: false,
        file_id: expect.stringMatching(/^file_/),
        error: null,
        created_by_principal_type: 'user',
        created_by_principal_id: expect.stringMatching(/^user_/),
        finished_at: expect.any(String),
      });
      expect(sheet).toMatchObject({ transformation: 'sheet', format: 'xlsx' });

      const file = await authenticatedTestClient(userToken).get(
        `/api/v1/files/${proposal.file_id}`
      );
      expect(file.body).toMatchObject({
        content_type: 'application/pdf',
        path: expect.stringMatching(/^\/\.system\/playbooks\//),
      });
      const bytes = await asAdmin()
        .get(`/api/v1/files/${proposal.file_id}/download`)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('end', () => {
            done(null, Buffer.concat(chunks));
          });
        });
      expect(Buffer.compare(bytes.body, PDF)).toBe(0);
    });

    test("hands the tool the case, the revision and the node's output", async () => {
      const caseId = await newCase({});
      const revision = await writeAmount(caseId, 11);
      const before = stub.routeRequests.length;

      await exportNode(caseId, { wait: true, transformations: ['proposal'] });

      expect(stub.routeRequests.slice(before)).toHaveLength(1);
      expect(stub.routeRequests[before].body).toEqual({
        case_id: caseId,
        subject: expect.stringMatching(/^client-/),
        node_id: 'pricing',
        revision,
        output: { amount: 11 },
      });
    });

    test('renders only the transformations named', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId, {
        wait: true,
        transformations: ['sheet'],
      });

      expect(res.status).toBe(201);
      expect(
        res.body.data.map((each: { transformation: string }) => {
          return each.transformation;
        })
      ).toEqual(['sheet']);
    });

    test('renders an earlier revision, stale once the output moved', async () => {
      const caseId = await newCase({});
      const first = await writeAmount(caseId, 2);
      const second = await writeAmount(caseId, 3);
      const before = stub.routeRequests.length;

      const res = await exportNode(caseId, {
        wait: true,
        revision: first,
        transformations: ['proposal'],
      });

      expect(res.status).toBe(201);
      expect(res.body.data[0]).toMatchObject({
        revision: first,
        status: 'completed',
        stale: true,
      });
      expect(stub.routeRequests[before].body.output).toEqual({ amount: 2 });
      expect(second).toBeGreaterThan(first);
    });

    test('without wait it answers running and settles in the background', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 4);

      const res = await exportNode(caseId, { transformations: ['proposal'] });

      expect(res.status).toBe(201);
      expect(res.body.data[0]).toMatchObject({
        status: 'running',
        file_id: null,
      });
      const settled = await pollUntil({
        read: async () => {
          const one = await asAdmin().get(
            `/api/v1/playbook-cases/${caseId}/exports/${res.body.data[0].id}`
          );
          return one.body;
        },
        done: (body) => {
          return body.status !== 'running';
        },
      });
      expect(settled).toMatchObject({
        status: 'completed',
        file_id: expect.stringMatching(/^file_/),
      });
    });

    test('fails an export whose file is not the format declared', async () => {
      const caseId = await newCase({
        transformations: [
          { name: 'proposal', format: 'pdf', tool: jsonToolId },
        ],
      });
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId);

      expect(res.status).toBe(201);
      expect(res.body.data[0]).toMatchObject({
        status: 'failed',
        file_id: null,
        error: {
          code: 'PLAYBOOK_EXPORT_FORMAT_MISMATCH',
          meta: { format: 'pdf', content_type: 'application/json' },
        },
      });
    });

    test('fails an export whose tool answers no file', async () => {
      const caseId = await newCase({
        transformations: [
          { name: 'proposal', format: 'json', tool: plainToolId },
        ],
      });
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId);

      expect(res.body.data[0]).toMatchObject({
        status: 'failed',
        error: { code: 'PLAYBOOK_EXPORT_FAILED' },
      });
    });

    test('fails an export whose tool call fails', async () => {
      const caseId = await newCase({
        transformations: [
          { name: 'proposal', format: 'pdf', tool: downToolId },
        ],
      });
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId);

      expect(res.body.data[0].status).toBe('failed');
      expect(res.body.data[0].error.code).toEqual(expect.any(String));
    });

    test('returns 409 for the latest revision of a node that is not done', async () => {
      const caseId = await newCase({});

      const res = await exportNode(caseId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_NODE_NOT_EXPORTABLE');
      expect(res.body.error.meta).toMatchObject({
        node_id: 'pricing',
        state: 'blocked',
      });
    });

    test('returns 400 for a revision that is no output of the node', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId, { wait: true, revision: 999 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a revision that is not an integer', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId, { wait: true, revision: 'latest' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for transformations that are not a list', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId, {
        wait: true,
        transformations: 'proposal',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a transformation the node does not declare', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId, {
        wait: true,
        transformations: ['brochure'],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for an empty list of transformations', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId, { wait: true, transformations: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a node with no transformations', async () => {
      const caseId = await newCase({ transformations: [] });
      await writeAmount(caseId, 1);

      const res = await exportNode(caseId);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 400 for a node the version does not declare', async () => {
      const caseId = await newCase({});

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/playbook-cases/${caseId}/nodes/nowhere/exports`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 409 on a paused case', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);
      await authenticatedTestClient(userToken).post(
        `/api/v1/playbook-cases/${caseId}/pause`
      );

      const res = await exportNode(caseId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_PAUSED');
    });

    test('returns 403 once the author may no longer call the tool', async () => {
      const authorToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'pbkexportauthor',
        actions: ['playbooks:CreatePlaybook', 'tools:CallTool'],
      });
      const caseId = await newCase({ token: authorToken });
      await writeAmount(caseId, 1);
      const me =
        await authenticatedTestClient(authorToken).get('/api/v1/users/me');
      await asAdmin()
        .put(`/api/v1/users/${me.body.id}/policies`)
        .send({ policy_ids: [] });

      const res = await exportNode(caseId);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTOR_FORBIDDEN');
      expect(res.body.error.meta).toEqual({
        node_id: 'pricing',
        action: 'tools:CallTool',
      });
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/playbook-cases/pbk_case_missing/nodes/pricing/exports')
        .send({});
      expect(res.status).toBe(401);
    });

    test('returns 403 to a member without the action', async () => {
      const caseId = await newCase({});
      const res = await exportNode(caseId, { wait: true }, readerToken);
      expect(res.status).toBe(403);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase({});
      const res = await exportNode(caseId, { wait: true }, noPermToken);
      expect(res.status).toBe(404);
    });

    test('returns 404 for an unknown case', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/playbook-cases/pbk_case_missing/nodes/pricing/exports')
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe('a definition naming a transformation', () => {
    test('returns 403 when the writer may not call its tool', async () => {
      const token = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'pbkexportwriter',
        actions: ['playbooks:CreatePlaybook'],
      });

      const res = await authenticatedTestClient(token)
        .post('/api/v1/playbooks')
        .send({
          project_id: projectId,
          name: 'export-forbidden',
          definition: finalNode([
            { name: 'proposal', format: 'pdf', tool: pdfToolId },
          ]),
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTOR_FORBIDDEN');
      expect(res.body.error.meta).toEqual({
        node_id: 'pricing',
        action: 'tools:CallTool',
      });
    });

    test('returns 400 for a format no export produces', async () => {
      const res = await asAdmin()
        .post('/api/v1/playbooks')
        .send({
          project_id: projectId,
          name: 'export-unknown-format',
          definition: finalNode([
            { name: 'proposal', format: 'exe', tool: pdfToolId },
          ]),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('reports two transformations of one name', async () => {
      const res = await asAdmin()
        .post('/api/v1/playbooks/validate')
        .send({
          definition: finalNode([
            { name: 'proposal', format: 'pdf', tool: pdfToolId },
            { name: 'proposal', format: 'xlsx', tool: sheetToolId },
          ]),
        });

      expect(res.status).toBe(200);
      expect(res.body.problems).toContainEqual({
        code: 'DUPLICATE_TRANSFORMATION',
        path: expect.stringMatching(/\.transformations\[1\]\.name$/),
        message: expect.stringContaining("'proposal'"),
      });
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/exports', () => {
    test('lists the exports, newest first, stale once the output moved', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);
      await exportNode(caseId, { wait: true, transformations: ['proposal'] });
      await writeAmount(caseId, 2);
      await exportNode(caseId, { wait: true, transformations: ['sheet'] });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/exports?node_id=pricing`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.data).toMatchObject([
        { transformation: 'sheet', stale: false },
        { transformation: 'proposal', stale: true },
      ]);
    });

    test('narrows to one transformation', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);
      await exportNode(caseId);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/exports?transformation=sheet`
      );

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].transformation).toBe('sheet');
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.get(
        '/api/v1/playbook-cases/pbk_case_missing/exports'
      );
      expect(res.status).toBe(401);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase({});
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/playbook-cases/${caseId}/exports`
      );
      expect(res.status).toBe(404);
    });

    test('returns 404 for an unknown case', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/playbook-cases/pbk_case_missing/exports'
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/exports/{export_id}', () => {
    test('returns one export', async () => {
      const caseId = await newCase({});
      await writeAmount(caseId, 1);
      const created = await exportNode(caseId, {
        wait: true,
        transformations: ['proposal'],
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/exports/${created.body.data[0].id}`
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(created.body.data[0]);
    });

    test('returns 404 for an export of another case', async () => {
      const caseId = await newCase({});
      const otherId = await newCase({});
      await writeAmount(otherId, 1);
      const created = await exportNode(otherId, {
        wait: true,
        transformations: ['proposal'],
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/exports/${created.body.data[0].id}`
      );

      expect(res.status).toBe(404);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.get(
        '/api/v1/playbook-cases/pbk_case_missing/exports/pbk_exp_missing'
      );
      expect(res.status).toBe(401);
    });

    test('returns 404 to a member without the action', async () => {
      const caseId = await newCase({});
      const res = await authenticatedTestClient(readerToken).get(
        `/api/v1/playbook-cases/${caseId}/exports/pbk_exp_missing`
      );
      expect(res.status).toBe(404);
    });
  });
});
