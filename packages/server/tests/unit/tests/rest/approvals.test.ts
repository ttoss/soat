import { db } from 'src/db';
import {
  emitApproval as emitApprovalLib,
  expireApprovalIfDue,
  listApprovals,
  type MappedApproval,
} from 'src/lib/approvals';
import { expireDueApprovals } from 'src/lib/approvalScheduler';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// The approvals queue has no public create endpoint — items are platform-created
// (an `approval` node in Phase 1; tool-call interception in Phase 2). There is
// therefore no REST entry point to seed through, so tests seed via the module's
// own `emitApproval` (the sanctioned "no entry point exists" lib path), then
// exercise list/get/approve/reject/expiry through REST as a real client would.

describe('Approvals', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectInternalId: number;

  const seedApproval = async (
    overrides: Partial<Parameters<typeof emitApprovalLib>[0]> = {}
  ): Promise<MappedApproval> => {
    return emitApprovalLib({
      projectId: projectInternalId,
      proposedAction: {
        toolId: 'tool_seedtool00000',
        arguments: { amount: 500 },
      },
      reasoning: 'Refund exceeds auto-approve threshold',
      evidence: { orderId: 'ord_123' },
      predictedImpact: 'Issues a $500 refund',
      expiresInSeconds: 3600,
      ...overrides,
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'approvals',
      policyActions: [
        'approvals:ListApprovals',
        'approvals:GetApproval',
        'approvals:ResolveApproval',
      ],
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;
  });

  describe('GET /api/v1/approvals', () => {
    test('lists approval items with the full shape', async () => {
      const seeded = await seedApproval();

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const found = res.body.find((a: { id: string }) => {
        return a.id === seeded.id;
      });
      expect(found).toBeDefined();
      expect(found.id).toMatch(/^apr_/);
      expect(found.status).toBe('pending');
      expect(found.origin).toBe('node');
      expect(found.project_id).toBe(projectId);
      expect(found.proposed_action.tool_id).toBe('tool_seedtool00000');
      expect(found.proposed_action.arguments).toEqual({ amount: 500 });
      expect(found.reasoning).toBe('Refund exceeds auto-approve threshold');
      expect(found.expires_at).toBeDefined();
      // Internal columns must never leak.
      expect(found.orchestration_run_id).toBeUndefined();
      expect(found.resolved_by_user_id).toBeUndefined();
    });

    test('filters by status', async () => {
      const pending = await seedApproval();
      const toReject = await seedApproval();
      await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${toReject.id}/reject`)
        .send({ reason: 'not this one' });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals?project_id=${projectId}&status=pending`
      );

      expect(res.status).toBe(200);
      const ids = res.body.map((a: { id: string }) => {
        return a.id;
      });
      expect(ids).toContain(pending.id);
      expect(ids).not.toContain(toReject.id);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/approvals');
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/approvals?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/approvals/:approval_id', () => {
    test('returns a single item with evidence', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals/${seeded.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(seeded.id);
      // The caseTransform middleware recursively snake_cases response JSON, so
      // the opaque evidence object's keys come back snake_cased too.
      expect(res.body.evidence).toEqual({ order_id: 'ord_123' });
      expect(res.body.predicted_impact).toBe('Issues a $500 refund');
    });

    test('missing item returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/approvals/apr_doesnotexist0'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('APPROVAL_NOT_FOUND');
    });

    test('unauthenticated request returns 401', async () => {
      const seeded = await seedApproval();
      const res = await testClient.get(`/api/v1/approvals/${seeded.id}`);
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/approvals/${seeded.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/approvals/:approval_id/approve', () => {
    test('approves a pending item and records the resolver', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.resolved_by).toMatch(/^user_/);
      expect(res.body.edited_arguments).toBeNull();
    });

    test('edit-then-approve stores the edited arguments', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({ arguments: { amount: 450 } });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.edited_arguments).toEqual({ amount: 450 });
      // The original proposal is preserved.
      expect(res.body.proposed_action.arguments).toEqual({ amount: 500 });
    });

    test('rejects non-object edited arguments with 400', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({ arguments: [1, 2, 3] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('APPROVAL_INVALID_EDIT');
    });

    test('approving an already-resolved item returns 409', async () => {
      const seeded = await seedApproval();
      await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('APPROVAL_ALREADY_RESOLVED');
    });

    test('approving an expired item returns 409', async () => {
      const seeded = await seedApproval({ expiresInSeconds: -10 });
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('APPROVAL_EXPIRED');
    });

    test('unauthenticated request returns 401', async () => {
      const seeded = await seedApproval();
      const res = await testClient
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/approvals/:approval_id/reject', () => {
    test('rejects a pending item with a reason', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/reject`)
        .send({ reason: 'Exceeds monthly budget' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.resolution_reason).toBe('Exceeds monthly budget');
      expect(res.body.resolved_by).toMatch(/^user_/);
    });

    test('missing reason returns 400', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/reject`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('rejecting an already-resolved item returns 409', async () => {
      const seeded = await seedApproval();
      await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/reject`)
        .send({ reason: 'first' });
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/reject`)
        .send({ reason: 'second' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('APPROVAL_ALREADY_RESOLVED');
    });

    test('user without permission returns 403', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/approvals/${seeded.id}/reject`)
        .send({ reason: 'nope' });
      expect(res.status).toBe(403);
    });
  });

  describe('expiry enforcement', () => {
    test('the sweeper flips due pending items to expired', async () => {
      const seeded = await seedApproval({ expiresInSeconds: -10 });

      const claimed = await expireDueApprovals();
      expect(claimed).toBeGreaterThanOrEqual(1);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals/${seeded.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('expired');
    });

    test('expireApprovalIfDue is a no-op for an item not yet due', async () => {
      const seeded = await seedApproval({ expiresInSeconds: 3600 });
      const result = await expireApprovalIfDue({ id: seeded.id });
      expect(result).toBeNull();

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals/${seeded.id}`
      );
      expect(res.body.status).toBe('pending');
    });

    test('a tool_call-origin item is filtered by origin', async () => {
      const seeded = await seedApproval({
        origin: 'tool_call',
        dedupKey: 'approvals:dedup:1',
      });

      const items = await listApprovals({
        projectIds: [projectInternalId],
        origin: 'tool_call',
      });
      const found = items.find((a) => {
        return a.id === seeded.id;
      });
      expect(found).toBeDefined();
      expect(found!.origin).toBe('tool_call');
      expect(found!.dedupKey).toBe('approvals:dedup:1');
    });
  });

  // A project-scoped principal (project key / OAuth token) carries a policy
  // whose resources are SRN-scoped to the project (`soat:<project>:*:*`) rather
  // than the wildcard `*` the other tests use. The get/approve/reject handlers
  // must therefore check against a concrete item SRN — not the implicit `*`
  // default — or the SRN-scoped Allow never matches and every resolution 403s
  // even though list succeeds. This reproduces the list-allowed/get-denied split
  // reported in A-1.
  describe('SRN-scoped principal can resolve, not just list', () => {
    let scopedToken: string;

    beforeAll(async () => {
      scopedToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'approvalsscoped',
        actions: [
          'approvals:ListApprovals',
          'approvals:GetApproval',
          'approvals:ResolveApproval',
        ],
      });
    });

    test('lists approvals scoped to the project', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(scopedToken).get(
        `/api/v1/approvals?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(
        res.body.some((a: { id: string }) => {
          return a.id === seeded.id;
        })
      ).toBe(true);
    });

    test('gets a single approval item', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(scopedToken).get(
        `/api/v1/approvals/${seeded.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(seeded.id);
    });

    test('approves a pending item', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
    });

    test('rejects a pending item', async () => {
      const seeded = await seedApproval();
      const res = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/approvals/${seeded.id}/reject`)
        .send({ reason: 'scoped rejection' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
    });
  });
});
