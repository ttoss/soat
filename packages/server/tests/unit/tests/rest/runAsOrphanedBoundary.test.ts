import jwt from 'jsonwebtoken';
import { triggerAuthority } from 'src/lib/workAuthority';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  authenticatedTestClient,
  workAuthorityOf,
  workRequest,
} from '../../testClient';

/**
 * Stored work outlives the API key or trigger whose policy bounds it. Once
 * that source is gone the work authorizes nothing, rather than falling back to
 * everything its owner may do. The owner here is an admin, whose fallback
 * would be the wildcard.
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

describe('stored work whose boundary source is gone', () => {
  test('work whose API key was deleted is refused', async () => {
    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        name: 'runasorphan-key',
        policy_ids: [policyId],
      });
    expect(keyRes.status).toBe(201);

    const listTools = () => {
      return workRequest({
        authority: workAuthorityOf({
          project: projectId,
          user: adminPublicId,
          key: keyRes.body.id,
          work: 'orun_orphan1',
        }),
        method: 'get',
        path: `/api/v1/tools?project_id=${projectId}`,
      });
    };
    expect((await listTools()).status).toBe(200);

    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/api-keys/${keyRes.body.id}`
    );
    expect(deleted.status).toBe(204);

    const res = await listTools();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('a firing whose trigger was deleted is refused', async () => {
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
        policy_ids: [policyId],
      });
    expect(triggerRes.status).toBe(201);

    const listTriggers = () => {
      return workRequest({
        authority: triggerAuthority({
          triggerPublicId: triggerRes.body.id,
          projectPublicId: projectId,
        }),
        method: 'get',
        path: `/api/v1/triggers?project_id=${projectId}`,
      });
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
