import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const GUARDRAIL_VERSION_ACTIONS = [
  'guardrails:CreateGuardrail',
  'guardrails:GetGuardrail',
  'guardrails:UpdateGuardrail',
  'guardrails:DeleteGuardrail',
  'guardrails:ListGuardrailVersions',
  'guardrails:GetGuardrailVersion',
  'guardrails:RestoreGuardrailVersion',
];

/**
 * Guardrail version history, on the shared archive engine (issue #877).
 *
 * Every assertion drives the REST entry point: versions are written by the
 * shared lib choke point in `guardrails.ts`, so a create, a `PATCH` and a
 * restore are indistinguishable from here — which is the property under test.
 */
describe('Guardrail versions', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;

  const createGuardrail = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body;
  };

  const patchGuardrail = async (
    id: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const res = await authenticatedTestClient(userToken)
      .patch(`/api/v1/guardrails/${id}`)
      .send(body);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'guardver',
      policyActions: GUARDRAIL_VERSION_ACTIONS,
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;
  });

  describe('archiving', () => {
    test('creating a guardrail archives version 1', async () => {
      const guardrail = await createGuardrail({
        name: 'Archive On Create',
        document: { class: 'C' },
        version_label: 'initial',
      });
      expect(guardrail.version).toBe(1);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/1`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^guard_ver_/);
      expect(res.body.guardrail_id).toBe(guardrail.id);
      expect(res.body.version).toBe(1);
      expect(res.body.config).toEqual({ document: { class: 'C' } });
      expect(res.body.label).toBe('initial');
      expect(res.body.created_by).toBe(userId);
      expect(res.body.created_at).toBeDefined();
    });

    test('the archived config carries the document and nothing else', async () => {
      const guardrail = await createGuardrail({
        name: 'Config Shape',
        description: 'metadata that is not versioned',
        document: { class: 'B', default_class: 'C' },
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/1`
      );

      // Pinned deliberately. Only the policy `document` is versioned: bumping
      // the version when a name or description changes would make two version
      // numbers denote the same policy, which is exactly what an evaluation
      // record cites.
      expect(Object.keys(res.body.config)).toEqual(['document']);
      // The document is copied as a value, so its contract-fixed keys survive
      // verbatim — `default_class` is not re-cased on the way in or out.
      expect(res.body.config.document).toEqual({
        class: 'B',
        default_class: 'C',
      });
    });

    test('a document change bumps the version and archives the new document', async () => {
      const guardrail = await createGuardrail({
        name: 'Bumps',
        document: { class: 'C' },
      });

      const updated = await patchGuardrail(guardrail.id, {
        document: { class: 'B' },
        version_label: 'tightened',
      });
      expect(updated.version).toBe(2);

      const v1 = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/1`
      );
      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/2`
      );

      expect(v1.body.config.document.class).toBe('C');
      expect(v2.body.config.document.class).toBe('B');
      expect(v2.body.label).toBe('tightened');
    });

    test('a metadata-only edit archives no version', async () => {
      const guardrail = await createGuardrail({
        name: 'Metadata Only',
        document: { class: 'C' },
      });

      const updated = await patchGuardrail(guardrail.id, {
        name: 'Metadata Only, Renamed',
        description: 'still the same policy',
        context_mode: 'replace',
      });

      expect(updated.version).toBe(1);
      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('re-writing the document the guardrail already holds archives no version', async () => {
      const guardrail = await createGuardrail({
        name: 'No-op Write',
        document: { class: 'B', default_class: 'C' },
      });

      // Same document, different key order — the comparison is structural.
      const updated = await patchGuardrail(guardrail.id, {
        document: { default_class: 'C', class: 'B' },
      });

      expect(updated.version).toBe(1);
      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });
  });

  describe('GET /api/v1/guardrails/:guardrail_id/versions', () => {
    let listedId: string;

    beforeAll(async () => {
      const guardrail = await createGuardrail({
        name: 'Listed',
        document: { class: 'A' },
      });
      listedId = guardrail.id;
      await patchGuardrail(listedId, { document: { class: 'B' } });
      await patchGuardrail(listedId, { document: { class: 'C' } });
    });

    test('lists versions newest first', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${listedId}/versions`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(
        res.body.data.map((row: { version: number }) => {
          return row.version;
        })
      ).toEqual([3, 2, 1]);
      expect(res.body.data[0].config.document.class).toBe('C');
    });

    test('honors limit and offset', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${listedId}/versions?limit=1&offset=1`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.limit).toBe(1);
      expect(res.body.offset).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].version).toBe(2);
    });

    test('unknown guardrail returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/guardrails/guard_missing/versions'
      );
      expect(res.status).toBe(404);
    });

    test('a guardrail in another project resolves as not found', async () => {
      const other = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: otherProjectId,
          name: 'Other Project',
          document: { class: 'C' },
        });
      expect(other.status).toBe(201);

      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/guardrails/${other.body.id}/versions`
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/guardrails/${listedId}/versions`
      );
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/guardrails/:guardrail_id/versions/:version/restore', () => {
    test('restore appends a new version rather than rewinding the counter', async () => {
      const guardrail = await createGuardrail({
        name: 'Restorable',
        document: { class: 'A' },
      });
      await patchGuardrail(guardrail.id, { document: { class: 'D' } });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/guardrails/${guardrail.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(3);
      expect(res.body.document).toEqual({ class: 'A' });

      // Version 2 — the policy that was rolled back — is still retrievable, so
      // an exception or approval item citing it does not dangle.
      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/2`
      );
      expect(v2.status).toBe(200);
      expect(v2.body.config.document).toEqual({ class: 'D' });

      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/3`
      );
      expect(v3.body.config.document).toEqual({ class: 'A' });
      expect(v3.body.label).toBe('restored from v1');
      expect(v3.body.created_by).toBe(userId);
    });

    test('an explicit label annotates the version the restore creates', async () => {
      const guardrail = await createGuardrail({
        name: 'Labelled Restore',
        document: { class: 'A' },
      });
      await patchGuardrail(guardrail.id, { document: { class: 'D' } });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${guardrail.id}/versions/1/restore`)
        .send({ label: 'rollback to pre-incident policy' });

      expect(res.status).toBe(200);
      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions/3`
      );
      expect(v3.body.label).toBe('rollback to pre-incident policy');
    });

    test('restoring the live policy is a no-op that creates no version', async () => {
      const guardrail = await createGuardrail({
        name: 'Restore Current',
        document: { class: 'C' },
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/guardrails/${guardrail.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('restore leaves metadata untouched — only the policy rolls back', async () => {
      const guardrail = await createGuardrail({
        name: 'Metadata Survives',
        document: { class: 'A' },
      });
      await patchGuardrail(guardrail.id, { document: { class: 'D' } });
      await patchGuardrail(guardrail.id, {
        name: 'Renamed After The Edit',
        description: 'set after version 2',
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/guardrails/${guardrail.id}/versions/1/restore`
      );

      expect(res.status).toBe(200);
      expect(res.body.document).toEqual({ class: 'A' });
      expect(res.body.name).toBe('Renamed After The Edit');
      expect(res.body.description).toBe('set after version 2');
    });

    test('unknown version returns 404', async () => {
      const guardrail = await createGuardrail({
        name: 'Missing Version Restore',
        document: { class: 'C' },
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/guardrails/${guardrail.id}/versions/99/restore`
      );
      expect(res.status).toBe(404);
    });

    test('non-integer version returns 400', async () => {
      const guardrail = await createGuardrail({
        name: 'Bad Version Restore',
        document: { class: 'C' },
      });

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/guardrails/${guardrail.id}/versions/abc/restore`
      );
      expect(res.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post(
        '/api/v1/guardrails/guard_whatever/versions/1/restore'
      );
      expect(res.status).toBe(401);
    });

    test('a user without RestoreGuardrailVersion is refused', async () => {
      const guardrail = await createGuardrail({
        name: 'No Restore Permission',
        document: { class: 'C' },
      });

      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/guardrails/${guardrail.id}/versions/1/restore`
      );
      // `noPermToken` resolves to an empty project list, so the guardrail is
      // invisible rather than forbidden — the same shape as a cross-tenant read.
      expect(res.status).toBe(404);
    });
  });

  describe('deletion', () => {
    test('deleting a guardrail removes its archived versions', async () => {
      const guardrail = await createGuardrail({
        name: 'Deleted With Versions',
        document: { class: 'C' },
      });
      await patchGuardrail(guardrail.id, { document: { class: 'B' } });

      const del = await authenticatedTestClient(userToken).delete(
        `/api/v1/guardrails/${guardrail.id}`
      );
      expect(del.status).toBe(204);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.id}/versions`
      );
      expect(versions.status).toBe(404);
    });
  });

  describe('a restricted API key', () => {
    /**
     * A project-scoped API key whose policy excludes `excludedAction`. Unlike
     * `noPermToken` — which resolves to an empty project list and 404s — this
     * reaches the route with a resolvable project and exercises the 403 branch.
     */
    const createRestrictedApiKey = async (excludedAction: string) => {
      const allowedActions = GUARDRAIL_VERSION_ACTIONS.filter((action) => {
        return action !== excludedAction;
      });
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: { statement: [{ effect: 'Allow', action: allowedActions }] },
        });
      expect(policyRes.status).toBe(201);

      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          project_id: projectId,
          name: `No ${excludedAction} Key`,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      return keyRes.body.key as string;
    };

    test('without ListGuardrailVersions returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'guardrails:ListGuardrailVersions'
      );
      const res = await authenticatedTestClient(rawKey).get(
        '/api/v1/guardrails/guard_anything/versions'
      );
      expect(res.status).toBe(403);
    });

    test('without RestoreGuardrailVersion returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'guardrails:RestoreGuardrailVersion'
      );
      const res = await authenticatedTestClient(rawKey).post(
        '/api/v1/guardrails/guard_anything/versions/1/restore'
      );
      expect(res.status).toBe(403);
    });
  });
});
