import jwt from 'jsonwebtoken';
import { signRunToken } from 'src/lib/orchestrationRunToken';
import { signTriggerToken } from 'src/lib/triggerToken';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A run-as token already minted outlives the API key or trigger whose policy
 * was its boundary. Once that source is gone the token authorizes nothing,
 * rather than falling back to everything its owner may do. The owner here is
 * an admin, whose fallback would be the wildcard.
 */

let adminToken: string;
let adminPublicId: string;
let projectId: string;
let policyId: string;

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'runasorphan',
    policyActions: ['tools:ListTools', 'triggers:ListTriggers'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
  policyId = setup.policyId;
  adminPublicId = (jwt.decode(adminToken) as { publicId: string }).publicId;
});

describe('a run-as token whose boundary source is gone', () => {
  test('a run token whose API key was deleted is refused', async () => {
    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        name: 'runasorphan-key',
        policy_ids: [policyId],
      });
    expect(keyRes.status).toBe(201);

    const runToken = signRunToken({
      publicId: adminPublicId,
      role: 'admin',
      projectPublicId: projectId,
      workPublicId: 'orun_orphan1',
      apiKeyPublicId: keyRes.body.id,
    });
    const listTools = () => {
      return authenticatedTestClient(runToken).get(
        `/api/v1/tools?project_id=${projectId}`
      );
    };
    expect((await listTools()).status).toBe(200);

    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/api-keys/${keyRes.body.id}`
    );
    expect(deleted.status).toBe(204);

    const res = await listTools();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('a trigger token whose trigger was deleted is refused', async () => {
    const orchestrationRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'runasorphan-orchestration',
        nodes: [{ id: 'start', type: 'transform', expression: { var: '' } }],
        edges: [],
      });
    expect(orchestrationRes.status).toBe(201);
    const triggerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: 'runasorphan-trigger',
        type: 'manual',
        target_type: 'orchestration',
        target_id: orchestrationRes.body.id,
        policy_id: policyId,
      });
    expect(triggerRes.status).toBe(201);

    const triggerToken = signTriggerToken({
      publicId: adminPublicId,
      role: 'admin',
      projectPublicId: projectId,
      triggerId: triggerRes.body.id,
    });
    const listTriggers = () => {
      return authenticatedTestClient(triggerToken).get(
        `/api/v1/triggers?project_id=${projectId}`
      );
    };
    expect((await listTriggers()).status).toBe(200);

    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/triggers/${triggerRes.body.id}`
    );
    expect(deleted.status).toBe(204);

    const res = await listTriggers();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
