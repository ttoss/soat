import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers, testGrant } from '../../fixtures/bootstrap';
import { createPlaybookCase } from '../../fixtures/playbookCase';
import { authenticatedTestClient, testClient } from '../../testClient';

const amount = (schema: object = { type: 'number' }) => {
  return { name: 'amount', schema, required: true, source: 'manual' };
};

const definitionWith = (args: { title: string; schema?: object }) => {
  return {
    nodes: [
      {
        id: 'revenue',
        title: args.title,
        kind: 'collect',
        final: true,
        inputs: [amount(args.schema)],
      },
    ],
  };
};

const V1 = definitionWith({ title: 'Revenue' });

describe('Playbook auto_upgrade', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const newPlaybook = async (body: Record<string, unknown> = {}) => {
    seq += 1;
    const res = await asAdmin()
      .post('/api/v1/playbooks')
      .send({
        policy_ids: await testGrant({ token: adminToken }),
        project_id: projectId,
        name: `auto-upgrade-${seq}`,
        definition: V1,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; auto_upgrade: boolean };
  };

  const newCase = async (args: { playbookId: string; amount?: number }) => {
    const res = await createPlaybookCase({
      client: asAdmin(),
      playbookId: args.playbookId,
      body: { subject: `client-${seq}` },
    });
    expect(res.status).toBe(201);
    const caseId = res.body.id as string;
    if (args.amount !== undefined) {
      const write = await asAdmin()
        .post(`/api/v1/playbook-cases/${caseId}/inputs`)
        .send({
          inputs: [
            {
              node_id: 'revenue',
              name: 'amount',
              value: args.amount,
              expected_revision: null,
            },
          ],
        });
      expect(write.status).toBe(200);
      await flushPlaybookExecutions();
    }
    return caseId;
  };

  const redefine = async (playbookId: string, definition: object) => {
    const res = await asAdmin()
      .patch(`/api/v1/playbooks/${playbookId}`)
      .send({ definition });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
    return res.body.version as number;
  };

  const readCase = async (caseId: string) => {
    const res = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookautoupgrade',
      policyActions: ['playbooks:GetPlaybook'],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
  });

  describe('POST /api/v1/playbooks', () => {
    test('defaults auto_upgrade to false', async () => {
      const playbook = await newPlaybook();

      expect(playbook.auto_upgrade).toBe(false);
    });

    test('stores auto_upgrade when given', async () => {
      const playbook = await newPlaybook({ auto_upgrade: true });

      expect(playbook.auto_upgrade).toBe(true);
    });

    test('refuses a non-boolean auto_upgrade', async () => {
      const res = await asAdmin()
        .post('/api/v1/playbooks')
        .send({
          policy_ids: await testGrant({ token: adminToken }),
          project_id: projectId,
          name: 'auto-upgrade-bad',
          definition: V1,
          auto_upgrade: 'yes',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /api/v1/playbooks/{playbook_id}', () => {
    test('turns auto_upgrade on without archiving a version', async () => {
      const playbook = await newPlaybook();

      const res = await asAdmin()
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ auto_upgrade: true });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ auto_upgrade: true, version: 1 });
    });

    test('returns 401 without credentials', async () => {
      const playbook = await newPlaybook();

      const res = await testClient
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ auto_upgrade: true });

      expect(res.status).toBe(401);
    });

    test('returns 403 without playbooks:UpdatePlaybook', async () => {
      const playbook = await newPlaybook();

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ auto_upgrade: true });

      expect(res.status).toBe(403);
    });

    test('returns 404 to a caller whose policies name no project', async () => {
      const playbook = await newPlaybook();

      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/playbooks/${playbook.id}`)
        .send({ auto_upgrade: true });

      expect(res.status).toBe(404);
    });

    test('a new version moves every compatible case to it', async () => {
      const playbook = await newPlaybook({ auto_upgrade: true });
      const filled = await newCase({ playbookId: playbook.id, amount: 5 });
      const empty = await newCase({ playbookId: playbook.id });

      const version = await redefine(
        playbook.id,
        definitionWith({ title: 'Annual revenue' })
      );

      expect(version).toBe(2);
      for (const caseId of [filled, empty]) {
        expect(await readCase(caseId)).toMatchObject({
          playbook_version: 2,
          upgrade_error: null,
        });
      }
      const upgrades = await asAdmin().get(
        `/api/v1/playbook-cases/${filled}/upgrades`
      );
      expect(upgrades.body.data).toMatchObject([
        { case_id: filled, from_version: 1, to_version: 2 },
      ]);
    });

    test('a case whose stored input the new schema refuses stays and says why', async () => {
      const playbook = await newPlaybook({ auto_upgrade: true });
      const refused = await newCase({ playbookId: playbook.id, amount: 5 });
      const empty = await newCase({ playbookId: playbook.id });

      await redefine(
        playbook.id,
        definitionWith({ title: 'Revenue', schema: { type: 'string' } })
      );

      expect(await readCase(refused)).toMatchObject({
        playbook_version: 1,
        upgrade_error: {
          code: 'PLAYBOOK_INPUT_INVALID',
          meta: {
            version: 2,
            inputs: [{ node_id: 'revenue', name: 'amount' }],
          },
        },
      });
      expect(await readCase(empty)).toMatchObject({
        playbook_version: 2,
        upgrade_error: null,
      });
    });

    test('an upgrade of a held-back case clears its upgrade_error', async () => {
      const playbook = await newPlaybook({ auto_upgrade: true });
      const caseId = await newCase({ playbookId: playbook.id, amount: 5 });
      await redefine(
        playbook.id,
        definitionWith({ title: 'Revenue', schema: { type: 'string' } })
      );

      const res = await asAdmin()
        .post(`/api/v1/playbook-cases/${caseId}/upgrade`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        playbook_version: 2,
        upgrade_error: null,
      });
    });

    test('with auto_upgrade false every case stays on its version', async () => {
      const playbook = await newPlaybook();
      const caseId = await newCase({ playbookId: playbook.id, amount: 5 });

      await redefine(playbook.id, definitionWith({ title: 'Annual revenue' }));

      expect(await readCase(caseId)).toMatchObject({
        playbook_version: 1,
        upgrade_error: null,
      });
    });
  });
});
