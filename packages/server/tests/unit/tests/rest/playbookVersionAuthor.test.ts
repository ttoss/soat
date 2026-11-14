import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import { flushPlaybookExecutions } from 'src/lib/playbookCascade';
import { signToken } from 'src/lib/signedTokens';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A version's executors run as the credential that wrote it: an API key on its
 * owner's grant, an IAM token held to its bound as well. A trigger or OAuth
 * token cannot be restated as an author, so it writes no executor.
 */
describe('Playbook version authors', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let toolId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  /** One `execute` node calling the tool on a manual `amount`. */
  const definition = () => {
    return {
      nodes: [
        {
          id: 'pricing',
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
          executor: { type: 'tool', id: toolId },
        },
      ],
    };
  };

  const writePlaybook = (credential: string) => {
    seq += 1;
    return authenticatedTestClient(credential)
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: `author-${seq}`,
        definition: definition(),
      });
  };

  /** Writes `amount` on a new case of `playbookId`, which runs its executor. */
  const runCase = async (playbookId: string) => {
    seq += 1;
    const created = await asAdmin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `case-${seq}` });
    expect(created.status).toBe(201);
    const caseId = created.body.id as string;
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'pricing',
            name: 'amount',
            value: 1,
            expected_revision: null,
          },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
    const executions = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/executions`
    );
    return { caseId, execution: executions.body.data[0] };
  };

  const writtenBy = async (credential: string) => {
    const playbook = await writePlaybook(credential);
    expect(playbook.status).toBe(201);
    return playbook.body.id as string;
  };

  const mintKey = async () => {
    const res = await asAdmin()
      .post('/api/v1/api-keys')
      .send({ name: `author-key-${seq}`, project_id: projectId });
    expect(res.status).toBe(201);
    return { key: res.body.key as string, id: res.body.id as string };
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/constant': () => {
          return { body: { ok: true } };
        },
      },
    });
    const setup = await setupProjectWithUsers({
      prefix: 'playbookauthor',
      policyActions: ['playbooks:CreatePlaybook'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const tool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'author-constant',
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}/constant`, method: 'POST' },
      });
    expect(tool.status).toBe(201);
    toolId = tool.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    test('runs an API key author as that key', async () => {
      const { key, id } = await mintKey();

      const { execution } = await runCase(await writtenBy(key));

      expect(execution.status).toBe('completed');
      const version = await db.PlaybookVersion.findOne({
        where: { principalId: id },
      });
      expect(version).toMatchObject({
        principalKind: 'api_key',
        principalBound: null,
      });
    });

    test('runs nothing once the API key author is deleted', async () => {
      const { key, id } = await mintKey();
      const playbookId = await writtenBy(key);
      expect((await asAdmin().delete(`/api/v1/api-keys/${id}`)).status).toBe(
        204
      );

      const { caseId, execution } = await runCase(playbookId);

      expect(execution.error.code).toBe('WORK_AUTHORITY_MISSING');
      const res = await asAdmin()
        .post(`/api/v1/playbook-cases/${caseId}/nodes/pricing/run`)
        .send({ wait: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('WORK_AUTHORITY_MISSING');
    });

    test("stores an IAM token author's bound and runs held to it", async () => {
      const { key, id } = await mintKey();
      const token = await authenticatedTestClient(key)
        .post('/api/v1/iam/tokens')
        .send({
          policy: {
            statement: [
              {
                effect: 'Allow',
                action: ['playbooks:CreatePlaybook', 'tools:CallTool'],
              },
            ],
          },
        });
      expect(token.status).toBe(201);

      const { execution } = await runCase(await writtenBy(token.body.token));

      expect(execution.status).toBe('completed');
      const version = await db.PlaybookVersion.findOne({
        where: { principalId: id },
      });
      expect(version!.principalBound).toEqual({
        policy: {
          statement: [
            {
              effect: 'Allow',
              action: ['playbooks:CreatePlaybook', 'tools:CallTool'],
            },
          ],
        },
      });
    });
  });

  describe('POST /api/v1/playbooks', () => {
    test('is 409 for executors written with an OAuth token', async () => {
      const admin = jwt.decode(adminToken) as { publicId: string };
      const oauthToken = signToken({
        typ: 'oauth',
        claims: {
          publicId: admin.publicId,
          role: 'admin',
          scope: `playbooks:* tools:* prj:${projectId}`,
          prj: projectId,
        },
        expiresIn: '1h',
      });

      const res = await writePlaybook(oauthToken);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_AUTHOR_UNAVAILABLE');
    });
  });
});
