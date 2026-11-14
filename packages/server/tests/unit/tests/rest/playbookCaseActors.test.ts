import { setupProjectWithUsers, testGrant } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const DEFINITION = {
  nodes: [
    {
      id: 'revenue',
      title: 'Annual revenue',
      kind: 'collect',
      final: true,
      inputs: [
        {
          name: 'annual_revenue',
          schema: { type: 'number', minimum: 0 },
          required: true,
          source: 'manual',
        },
      ],
    },
  ],
};

describe('Playbook case actors', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let playbookId: string;
  let actorA: string;
  let actorB: string;
  let otherProjectActor: string;
  let seq = 0;

  const newCase = async (body: Record<string, unknown> = {}) => {
    seq += 1;
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `client-${seq}`, ...body });
    expect(res.status).toBe(201);
    return res.body as { id: string; subject: string };
  };

  beforeAll(() => {
    process.env.PLAYBOOK_WORKER_DISABLED = 'true';
  });

  afterAll(() => {
    delete process.env.PLAYBOOK_WORKER_DISABLED;
  });

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'playbookcaseactors',
      policyActions: ['playbooks:ListPlaybookCases'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    const playbook = await authenticatedTestClient(adminToken)
      .post('/api/v1/playbooks')
      .send({
        policy_ids: await testGrant({ token: adminToken }),
        project_id: projectId,
        name: 'actor-cases',
        definition: DEFINITION,
      });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body.id;

    const actor = async (project: string, name: string) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: project, name });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    actorA = await actor(projectId, 'Actor A');
    actorB = await actor(projectId, 'Actor B');
    otherProjectActor = await actor(setup.otherProjectId!, 'Elsewhere');
  });

  describe('POST /api/v1/playbooks/{playbook_id}/cases', () => {
    test('records the actor the case belongs to', async () => {
      const created = await newCase({ actor_id: actorA });

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/playbook-cases/${created.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.actor_id).toBe(actorA);
    });

    test('a case created without one belongs to no actor', async () => {
      const created = await newCase();
      expect(created).toMatchObject({ actor_id: null });
    });

    test('an unknown actor is 400 ACTOR_NOT_FOUND', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: 'nobody', actor_id: 'actor_doesNotExist0000' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
    });

    test("another project's actor is 400 ACTOR_NOT_FOUND", async () => {
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/playbooks/${playbookId}/cases`)
        .send({ subject: 'elsewhere', actor_id: otherProjectActor });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
    });
  });

  describe('GET /api/v1/playbook-cases', () => {
    test('actor_id lists only that actor’s cases', async () => {
      const mine = await newCase({ actor_id: actorA });
      const theirs = await newCase({ actor_id: actorB });
      const nobodys = await newCase();

      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/playbook-cases')
        .query({ project_id: projectId, actor_id: actorA, limit: 100 });
      expect(res.status).toBe(200);
      const ids = res.body.data.map((row: { id: string }) => {
        return row.id;
      });
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(ids).not.toContain(nobodys.id);
      for (const row of res.body.data) expect(row.actor_id).toBe(actorA);
    });

    test('subject lists only the cases about that subject', async () => {
      const target = await newCase({ actor_id: actorA });
      await newCase({ actor_id: actorA });

      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/playbook-cases')
        .query({ project_id: projectId, subject: target.subject });
      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).toEqual([target.id]);
    });

    test("an actor's subject of another actor lists nothing", async () => {
      const theirs = await newCase({ actor_id: actorB });

      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/playbook-cases')
        .query({
          project_id: projectId,
          actor_id: actorA,
          subject: theirs.subject,
        });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('a repeated actor_id is 400', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/playbook-cases?project_id=${projectId}&actor_id=${actorA}&actor_id=${actorB}`
      );
      expect(res.status).toBe(400);
    });

    test('401 without credentials', async () => {
      const res = await testClient
        .get('/api/v1/playbook-cases')
        .query({ project_id: projectId, actor_id: actorA });
      expect(res.status).toBe(401);
    });

    test('403 without ListPlaybookCases', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/playbook-cases')
        .query({ project_id: projectId, actor_id: actorA });
      expect(res.status).toBe(403);
    });
  });

  describe('a call pinned to an actor', () => {
    test("the actor's own case is reached", async () => {
      const mine = await newCase({ actor_id: actorA });
      const res = await authenticatedTestClient(adminToken)
        .get(`/api/v1/playbook-cases/${mine.id}`)
        .query({ actor_id: actorA });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(mine.id);
    });

    test("a write to the actor's own case lands", async () => {
      const mine = await newCase({ actor_id: actorA });
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/playbook-cases/${mine.id}/inputs`)
        .query({ actor_id: actorA })
        .send({
          inputs: [
            {
              node_id: 'revenue',
              name: 'annual_revenue',
              value: 1000,
              expected_revision: null,
            },
          ],
        });
      expect(res.status).toBe(200);
    });

    test('a repeated actor_id is 400', async () => {
      const mine = await newCase({ actor_id: actorA });
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/playbook-cases/${mine.id}?actor_id=${actorA}&actor_id=${actorA}`
      );
      expect(res.status).toBe(400);
    });
  });
});
