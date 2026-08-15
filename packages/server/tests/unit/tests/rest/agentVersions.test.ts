import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Agent versioning and staged rollout (the agents module doc — Versioning and Staged Rollout).
 *
 * Every assertion drives the REST entry point: version snapshots are written by
 * the shared lib choke point, so a `PUT`, a `PATCH`, and a formation apply are
 * indistinguishable from here — which is exactly the property under test.
 */
describe('Agent versions', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let aiProviderId: string;
  let noPermToken: string;

  const createAgent = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({ project_id: projectId, ai_provider_id: aiProviderId, ...body });
    expect(res.status).toBe(201);
    return res.body;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'agentver',
      policyActions: [
        'agents:CreateAgent',
        'agents:ListAgents',
        'agents:GetAgent',
        'agents:UpdateAgent',
        'agents:DeleteAgent',
        'agents:ListAgentVersions',
        'agents:GetAgentVersion',
        'agents:RestoreAgentVersion',
        'agents:SetAgentRelease',
        'evaluations:CreateDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:RunEval',
        'agents:CreateAgentGeneration',
        'agents:CreateSession',
        'agents:SendSessionMessage',
        'actors:CreateActor',
        'generations:GetGeneration',
        'generations:ListGenerations',
        'formations:CreateFormation',
        'formations:UpdateFormation',
        'formations:GetFormation',
        'formations:DeleteFormation',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Agent Versions Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  // ── Phase 1: snapshots ───────────────────────────────────────────────────

  describe('snapshot on create', () => {
    test('a new agent starts at version 1 with one archived version', async () => {
      const agent = await createAgent({ instructions: 'Be terse.' });

      expect(agent.version).toBe(1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions`
      );

      expect(versions.status).toBe(200);
      expect(versions.body.total).toBe(1);
      expect(versions.body.data).toHaveLength(1);
      expect(versions.body.data[0].version).toBe(1);
      expect(versions.body.data[0].id).toMatch(/^agver_/);
      expect(versions.body.data[0].agent_id).toBe(agent.id);
      expect(versions.body.data[0].config.instructions).toBe('Be terse.');
    });

    test('the snapshot captures exactly the agent’s mutable surface', async () => {
      const agent = await createAgent({ name: 'Snapshot Shape' });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/1`
      );

      expect(res.status).toBe(200);
      expect(res.body.config.name).toBe('Snapshot Shape');

      // Pinned deliberately. The snapshot is derived by *excluding* non-config
      // keys from the agent response, so a new agent field joins snapshots
      // automatically — which is what keeps `restore` complete. This assertion
      // is the counterweight: adding a field to the agent response makes it
      // fail, forcing a decision about whether the field is configuration
      // (leave it in) or bookkeeping (exclude it in agentVersionSnapshot.ts).
      expect(Object.keys(res.body.config).sort()).toEqual(
        [
          'active_tool_ids',
          'ai_provider_id',
          'boundary_policy',
          'guardrail_ids',
          'instructions',
          'knowledge_config',
          'max_context_messages',
          'max_steps',
          'model',
          'model_route_id',
          'name',
          'output_schema',
          'single_session_per_actor',
          'step_rules',
          'stop_conditions',
          'temperature',
          'tool_bindings',
          'tool_choice',
          // Configuration, not bookkeeping: the mode an agent ran under is part
          // of what `restore` must bring back, and a version whose config
          // omitted it would silently restore the project default instead.
          'trace_content_mode',
        ].sort()
      );
    });
  });

  describe('snapshot on update', () => {
    test('changing instructions bumps the version and archives the prior config', async () => {
      const agent = await createAgent({ instructions: 'v1 instructions' });

      const updated = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'v2 instructions' });

      expect(updated.status).toBe(200);
      expect(updated.body.version).toBe(2);
      expect(updated.body.instructions).toBe('v2 instructions');

      const v1 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/1`
      );
      expect(v1.status).toBe(200);
      expect(v1.body.config.instructions).toBe('v1 instructions');

      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/2`
      );
      expect(v2.status).toBe(200);
      expect(v2.body.config.instructions).toBe('v2 instructions');
    });

    test('a PATCH archives a version through the same choke point', async () => {
      const agent = await createAgent({ name: 'Patch Me' });

      const patched = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agent.id}`)
        .send({ name: 'Patched' });

      expect(patched.status).toBe(200);
      expect(patched.body.version).toBe(2);
    });

    test('an update with a deep-equal config creates no new version', async () => {
      const agent = await createAgent({ instructions: 'unchanged' });

      const noop = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'unchanged' });

      expect(noop.status).toBe(200);
      expect(noop.body.version).toBe(1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('version_label tags the version an update creates', async () => {
      const agent = await createAgent({ instructions: 'before tone change' });

      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'after tone change', version_label: 'tone-v2' });

      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/2`
      );
      expect(v2.body.label).toBe('tone-v2');
      // The label annotates the snapshot; it is never part of the config.
      expect(v2.body.config.version_label).toBeUndefined();
    });

    test('records the acting user as the version author', async () => {
      const agent = await createAgent({ instructions: 'authored' });

      const v1 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/1`
      );
      expect(v1.body.created_by).toMatch(/^user_/);
    });
  });

  describe('listing versions', () => {
    test('returns newest first and paginates', async () => {
      const agent = await createAgent({ instructions: 'one' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'two' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'three' });

      const all = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions`
      );
      expect(all.body.total).toBe(3);
      expect(
        all.body.data.map((v: { version: number }) => {
          return v.version;
        })
      ).toEqual([3, 2, 1]);

      const page = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions?limit=1&offset=1`
      );
      expect(page.body.total).toBe(3);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.data[0].version).toBe(2);
    });
  });

  // ── Phase 1: restore ─────────────────────────────────────────────────────

  describe('POST /api/v1/agents/{agent_id}/versions/{version}/restore', () => {
    test('restore is append-only: it creates a new version, keeping the intermediate one', async () => {
      const agent = await createAgent({ instructions: 'original' });

      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'regrettable edit' });

      const restored = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/versions/1/restore`
      );

      expect(restored.status).toBe(200);
      expect(restored.body.version).toBe(3);
      expect(restored.body.instructions).toBe('original');

      // Version 3's config deep-equals version 1's.
      const [v1, v3] = await Promise.all([
        authenticatedTestClient(userToken).get(
          `/api/v1/agents/${agent.id}/versions/1`
        ),
        authenticatedTestClient(userToken).get(
          `/api/v1/agents/${agent.id}/versions/3`
        ),
      ]);
      expect(v3.body.config).toEqual(v1.body.config);

      // The version that was undone stays retrievable — history never rewinds.
      const v2 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/2`
      );
      expect(v2.status).toBe(200);
      expect(v2.body.config.instructions).toBe('regrettable edit');
    });

    test('restoring the current config is a no-op that creates no version', async () => {
      const agent = await createAgent({ instructions: 'stable' });

      const restored = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/versions/1/restore`
      );

      expect(restored.status).toBe(200);
      expect(restored.body.version).toBe(1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions`
      );
      expect(versions.body.total).toBe(1);
    });

    test('restore fully replaces config, clearing fields the old version did not set', async () => {
      const agent = await createAgent({ instructions: 'lean' });

      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'lean', temperature: 0.9, max_steps: 7 });

      const restored = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/versions/1/restore`
      );

      expect(restored.status).toBe(200);
      expect(restored.body.temperature).toBeNull();
      expect(restored.body.max_steps).toBe(20);
    });

    test('labels the restored version by default', async () => {
      const agent = await createAgent({ instructions: 'first' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'second' });

      await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/versions/1/restore`
      );

      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/3`
      );
      expect(v3.body.label).toBe('restored from v1');
    });

    test('an explicit label overrides the default', async () => {
      const agent = await createAgent({ instructions: 'a' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'b' });

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agent.id}/versions/1/restore`)
        .send({ label: 'rollback-incident-42' });

      const v3 = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent.id}/versions/3`
      );
      expect(v3.body.label).toBe('rollback-incident-42');
    });

    test('restoring an unknown version returns 404', async () => {
      const agent = await createAgent({});

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/versions/99/restore`
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  // ── Phase 1: auth and isolation ──────────────────────────────────────────

  describe('authentication and authorization', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await createAgent({ instructions: 'guarded' });
      agentId = agent.id;
    });

    test('unauthenticated list returns 401', async () => {
      const res = await testClient.get(`/api/v1/agents/${agentId}/versions`);
      expect(res.status).toBe(401);
    });

    test('unauthenticated get returns 401', async () => {
      const res = await testClient.get(`/api/v1/agents/${agentId}/versions/1`);
      expect(res.status).toBe(401);
    });

    test('unauthenticated restore returns 401', async () => {
      const res = await testClient.post(
        `/api/v1/agents/${agentId}/versions/1/restore`
      );
      expect(res.status).toBe(401);
    });

    // These routes address an agent by ID with no `project_id` parameter, so a
    // principal lacking the action resolves to an empty project set and the
    // agent is simply not found. The status is 404 rather than 403 by design —
    // identical to `GET /api/v1/agents/{agent_id}` — and it is the stronger
    // answer: an unauthorized caller learns nothing about whether the agent
    // exists. What matters for the security property is that no history leaks,
    // which each of these asserts.
    test('user without permission gets no version list', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/agents/${agentId}/versions`
      );
      expect(res.status).toBe(404);
      expect(res.body.data).toBeUndefined();
    });

    test('user without permission gets no version', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/agents/${agentId}/versions/1`
      );
      expect(res.status).toBe(404);
      expect(res.body.config).toBeUndefined();
    });

    test('user without permission cannot restore a version', async () => {
      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/agents/${agentId}/versions/1/restore`
      );
      // A write refuses an empty scope outright — the `GET` twin above still
      // answers 404, but a restore the caller may not perform is a 403 (#1029).
      expect(res.status).toBe(403);

      // The write must not have landed: the agent is still on version 1.
      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.version).toBe(1);
    });

    test('unknown agent returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/agents/agent_doesnotexist0000/versions'
      );
      expect(res.status).toBe(404);
    });

    test('a project-scoped principal cannot read another project’s history', async () => {
      const otherAgentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({ project_id: otherProjectId, ai_provider_id: aiProviderId });
      expect(otherAgentRes.status).toBe(201);

      // The shared fixture user holds a wildcard policy, so it legitimately
      // reaches every project; a principal scoped to one project is what
      // actually exercises the tenant boundary.
      const scopedToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'agentverscoped',
        actions: ['agents:ListAgentVersions', 'agents:GetAgentVersion'],
      });

      const ownProject = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents/${agentId}/versions`
      );
      expect(ownProject.status).toBe(200);

      const crossProject = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents/${otherAgentRes.body.id}/versions`
      );
      expect(crossProject.status).toBe(404);
    });

    test('a non-integer version is rejected', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/versions/abc`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  // ── Phase 1: formation parity ────────────────────────────────────────────

  describe('formation applies leave history', () => {
    test('an agent created and updated by a formation is versioned like a REST agent', async () => {
      const template = (instructions: string) => {
        return {
          resources: {
            VersionedAgent: {
              type: 'agent',
              properties: { ai_provider_id: aiProviderId, instructions },
            },
          },
        };
      };

      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `agent-versions-formation-${Date.now()}`,
          template: template('formation v1'),
        });

      expect(created.status).toBe(201);
      const agentId = created.body.resources[0].physical_resource_id;

      const afterCreate = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/versions`
      );
      expect(afterCreate.body.total).toBe(1);
      expect(afterCreate.body.data[0].config.instructions).toBe('formation v1');

      const updated = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${created.body.id}`)
        .send({ template: template('formation v2') });
      expect(updated.status).toBe(200);

      const afterUpdate = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/versions`
      );
      expect(afterUpdate.body.total).toBe(2);
      expect(afterUpdate.body.data[0].version).toBe(2);
      expect(afterUpdate.body.data[0].config.instructions).toBe('formation v2');
      // Same shape as a REST-created version, attributed to the applying
      // principal rather than left anonymous.
      expect(afterUpdate.body.data[0].created_by).toMatch(/^user_/);
    });
  });

  // ── Phase 2: releases ────────────────────────────────────────────────────

  describe('PUT /api/v1/agents/{agent_id}/release', () => {
    const twoVersionAgent = async () => {
      const agent = await createAgent({ instructions: 'stable prompt' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'canary prompt' });
      return agent.id;
    };

    test('sets an active release', async () => {
      const agentId = await twoVersionAgent();

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 20 });

      expect(res.status).toBe(200);
      expect(res.body.active_release).toEqual({
        stable_version: 1,
        canary_version: 2,
        canary_percent: 20,
        // An ungated rollout still reports the field, so a client never has to
        // distinguish "no gate" from "an older server that had no gates".
        promotion_gate: null,
      });
    });

    test('an agent with no release reports active_release null', async () => {
      const agent = await createAgent({});
      expect(agent.active_release).toBeNull();
    });

    test('setting a release is not a config change and archives no version', async () => {
      const agentId = await twoVersionAgent();

      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 20 });

      // A rollout pointer sits outside the versioned surface on purpose: setting
      // one must not make the agent look edited. This is the behavioral guard
      // that the only writer outside the shared choke point touches no config
      // column.
      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/versions`
      );
      expect(versions.body.total).toBe(2);

      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.version).toBe(2);
    });

    test('a release referencing a nonexistent version returns 400', async () => {
      const agentId = await twoVersionAgent();

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 99, canary_percent: 10 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a canary equal to stable is rejected', async () => {
      const agentId = await twoVersionAgent();

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 1, canary_percent: 10 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an out-of-range canary_percent is rejected', async () => {
      const agentId = await twoVersionAgent();

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 101 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('promotion_gate is not accepted before Phase 3', async () => {
      const agentId = await twoVersionAgent();

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 10,
          promotion_gate: 'eval_notyet',
        });

      expect(res.status).toBe(400);
    });

    test('a principal without the release permission cannot set one', async () => {
      const agentId = await twoVersionAgent();

      const res = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 10 });

      // 403, not 404: the caller may write in no project at all, and the
      // denial is decided before the body is even validated (#1029).
      expect(res.status).toBe(403);

      // What matters is that no release was created.
      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.active_release).toBeNull();
    });

    test('unauthenticated release write returns 401', async () => {
      const agentId = await twoVersionAgent();

      const res = await testClient
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 10 });

      expect(res.status).toBe(401);
    });
  });

  describe('promote and abort', () => {
    // A release is set while the live row already holds the canary config
    // (the usual shape: edit the agent, then canary the new version).
    const releasedAgent = async () => {
      const agent = await createAgent({ instructions: 'stable prompt' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'canary prompt' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 50 });
      return agent.id;
    };

    test('promote makes the canary config live and clears the release', async () => {
      const agentId = await releasedAgent();

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/release/promote`
      );

      expect(res.status).toBe(200);
      expect(res.body.active_release).toBeNull();
      expect(res.body.instructions).toBe('canary prompt');
    });

    test('abort restores the stable config and clears the release', async () => {
      const agentId = await releasedAgent();

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/release/abort`
      );

      expect(res.status).toBe(200);
      expect(res.body.active_release).toBeNull();
      // The whole point of an abort: traffic goes back to the stable prompt,
      // not to whatever the live row happened to hold.
      expect(res.body.instructions).toBe('stable prompt');
      expect(res.body.version).toBe(3);
    });

    test('promote without an active release returns 409', async () => {
      const agent = await createAgent({});

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/release/promote`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NO_ACTIVE_RELEASE');
    });

    test('abort without an active release returns 409', async () => {
      const agent = await createAgent({});

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/release/abort`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NO_ACTIVE_RELEASE');
    });

    test('a principal without permission cannot promote', async () => {
      const agentId = await releasedAgent();

      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/agents/${agentId}/release/promote`
      );

      expect(res.status).toBe(403);

      // The rollout is untouched — an unauthorized call must not end it.
      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.active_release).not.toBeNull();
    });

    test('a principal without permission cannot abort', async () => {
      const agentId = await releasedAgent();

      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/agents/${agentId}/release/abort`
      );

      expect(res.status).toBe(403);

      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.active_release).not.toBeNull();
    });

    test('unauthenticated promote returns 401', async () => {
      const agentId = await releasedAgent();

      const res = await testClient.post(
        `/api/v1/agents/${agentId}/release/promote`
      );

      expect(res.status).toBe(401);
    });
  });

  // ── Phase 2: the served version reaches the generation record ────────────

  describe('served version stamping', () => {
    /**
     * Runs a generation and returns the version stamped on its record.
     *
     * The AI provider is unreachable in unit CI so the call fails with 502 —
     * but the record, and its served-version stamp, are written before the
     * model is ever contacted, which is exactly the part under test. The error
     * body carries the generation id for this reason.
     */
    const servedVersionOf = async (agentId: string): Promise<number> => {
      const generated = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(generated.status).toBe(502);
      const generationId = generated.body.error.meta.generation_id;
      expect(generationId).toBeDefined();

      const record = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${generationId}`
      );
      expect(record.status).toBe(200);
      return record.body.agent_version;
    };

    test('stamps the live version when there is no rollout', async () => {
      const agent = await createAgent({ instructions: 'only version' });

      expect(await servedVersionOf(agent.id)).toBe(1);
    }, 60000);

    test('stamps the version the rollout assigned, not the live row', async () => {
      const agent = await createAgent({ instructions: 'stable prompt' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'canary prompt' });

      // The live row now holds version 2. Driving the split from either end —
      // 0% and 100% — makes the assignment deterministic without depending on
      // how any particular key hashes, so this asserts the whole Phase 2 chain:
      // release pointer → assignment → archived config → stamped record.
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 0 });

      // Serves version 1 even though the live row is version 2 — the config a
      // rollout serves comes from the archive, never from the live columns.
      expect(await servedVersionOf(agent.id)).toBe(1);

      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 100 });

      expect(await servedVersionOf(agent.id)).toBe(2);
    }, 120000);

    /**
     * The split keys on the actor behind the session, so covering it means
     * driving generations through the session entry point rather than the direct
     * agent one (which has no end user attached).
     */
    describe('with an actor behind the session', () => {
      const newestServedVersion = async (agentId: string): Promise<number> => {
        const list = await authenticatedTestClient(userToken).get(
          `/api/v1/generations?agent_id=${agentId}`
        );
        expect(list.status).toBe(200);
        // Newest first.
        return list.body.data[0].agent_version;
      };

      const generateInSession = async (sessionId: string): Promise<void> => {
        // Fails upstream (no reachable provider) after the record is written.
        await authenticatedTestClient(userToken).post(
          `/api/v1/sessions/${sessionId}/generate?wait=true`
        );
      };

      test('resolves the actor and serves the assigned version', async () => {
        const agent = await createAgent({ instructions: 'stable prompt' });
        await authenticatedTestClient(userToken)
          .put(`/api/v1/agents/${agent.id}`)
          .send({ instructions: 'canary prompt' });

        const actor = await authenticatedTestClient(userToken)
          .post('/api/v1/actors')
          .send({ project_id: projectId, name: 'Rollout Subject' });
        expect(actor.status).toBe(201);

        const session = await authenticatedTestClient(userToken)
          .post('/api/v1/sessions')
          .send({ agent_id: agent.id, actor_id: actor.body.id });
        expect(session.status).toBe(201);
        expect(session.body.actor_id).toBe(actor.body.id);

        await authenticatedTestClient(userToken)
          .put(`/api/v1/agents/${agent.id}/release`)
          .send({ stable_version: 1, canary_version: 2, canary_percent: 0 });
        await generateInSession(session.body.id);
        expect(await newestServedVersion(agent.id)).toBe(1);

        await authenticatedTestClient(userToken)
          .put(`/api/v1/agents/${agent.id}/release`)
          .send({ stable_version: 1, canary_version: 2, canary_percent: 100 });
        await generateInSession(session.body.id);
        expect(await newestServedVersion(agent.id)).toBe(2);
      }, 120000);

      test('keeps one actor on one version across separate sessions', async () => {
        const agent = await createAgent({ instructions: 'stable prompt' });
        await authenticatedTestClient(userToken)
          .put(`/api/v1/agents/${agent.id}`)
          .send({ instructions: 'canary prompt' });

        const actor = await authenticatedTestClient(userToken)
          .post('/api/v1/actors')
          .send({ project_id: projectId, name: 'Sticky Subject' });

        // A percentage that actually splits, so the assertion is about the
        // hash being keyed on the actor rather than about which side it lands
        // on — that stays hash-dependent and is deliberately not asserted.
        await authenticatedTestClient(userToken)
          .put(`/api/v1/agents/${agent.id}/release`)
          .send({ stable_version: 1, canary_version: 2, canary_percent: 50 });

        const served: number[] = [];
        for (const label of ['first', 'second']) {
          const session = await authenticatedTestClient(userToken)
            .post('/api/v1/sessions')
            .send({
              agent_id: agent.id,
              actor_id: actor.body.id,
              name: `${label} conversation`,
            });
          expect(session.status).toBe(201);
          await generateInSession(session.body.id);
          served.push(await newestServedVersion(agent.id));
        }

        // Two separate conversations, one end user: a mid-relationship persona
        // change is worse than either version, so both must serve the same one.
        expect(served[0]).toBe(served[1]);
        expect([1, 2]).toContain(served[0]);
      }, 120000);
    });

    test('callers cannot forge the served version', async () => {
      const agent = await createAgent({});

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agent.id}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          metadata: { agent_version: 99 },
        });

      // The request is accepted — `agent_version` in the caller's bag is just
      // an annotation now. Attributing a canary's behavior to the stable
      // version (or the reverse) would corrupt every downstream comparison, so
      // what matters is that the served-version field is the resolver's, not
      // the caller's. It is a column the request body cannot address.
      expect(res.status).toBe(502);
      const record = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${res.body.error.meta.generation_id}`
      );
      expect(record.status).toBe(200);
      expect(record.body.agent_version).toBe(1);
      expect(record.body.metadata).toEqual({ agent_version: 99 });
    });
  });

  // ── Phase 3: eval-gated promotion ────────────────────────────────────────

  /**
   * A gate is an eval that must be green *against the canary version* before
   * the canary can go live. Everything here drives the two real entry points —
   * the release API and the evaluations API — with only the agent's generation
   * mocked, which is the one external boundary (`.claude/rules/tests.md`).
   */
  describe('eval-gated promotion', () => {
    let datasetId: string;

    /** An eval of `agent` that passes only when the agent answers "Paris". */
    const createGateEval = async (name: string, targetAgentId: string) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name,
          agent_id: targetAgentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
          pass_threshold: 1,
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    /**
     * A two-version agent mid-rollout, with the canary gated on a fresh eval.
     * Each test gets its own so a run started by one cannot satisfy another's
     * gate.
     */
    const gatedAgent = async (name: string) => {
      const agent = await createAgent({ instructions: 'stable prompt' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'canary prompt' });

      const evalId = await createGateEval(name, agent.id);

      const release = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 50,
          promotion_gate: evalId,
        });
      expect(release.status).toBe(200);

      return { agentId: agent.id as string, evalId };
    };

    /** Runs the gate's eval against one version, answering `answer` once. */
    const runEval = async (args: {
      evalId: string;
      version: number;
      answer: string;
    }) => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: `gen_gate_${args.version}_${args.answer}`,
        traceId: `trc_gate_${args.version}_${args.answer}`,
        status: 'completed' as const,
        output: {
          model: 'test-model',
          content: args.answer,
          finishReason: 'stop' as const,
        },
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/evals/${args.evalId}/runs`)
        .send({ wait: true, agent_version: args.version });

      expect(res.status).toBe(201);
      expect(res.body.agent_version).toBe(args.version);
      return res.body as { id: string; passed: boolean };
    };

    const promote = (agentId: string) => {
      return authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/release/promote`
      );
    };

    const liveVersionRow = async (agentId: string) => {
      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.status).toBe(200);
      const version = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/versions/${agent.body.version}`
      );
      expect(version.status).toBe(200);
      return version.body;
    };

    beforeAll(async () => {
      const dataset = await authenticatedTestClient(userToken)
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'gate-dataset' });
      expect(dataset.status).toBe(201);
      datasetId = dataset.body.id;

      const item = await authenticatedTestClient(userToken)
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({
          input: [{ role: 'user', content: 'Capital of France?' }],
          expected_output: 'Paris',
        });
      expect(item.status).toBe(201);
    });

    afterEach(() => {
      // Shared spy: clear queued implementations without unwiring it.
      jest.clearAllMocks();
    });

    test('the gate is stored on the release and echoed back', async () => {
      const { agentId, evalId } = await gatedAgent('gate-echo');

      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.active_release.promotion_gate).toBe(evalId);
    });

    test('promote with no run at all returns 409 and leaves the rollout running', async () => {
      const { agentId, evalId } = await gatedAgent('gate-no-run');

      const res = await promote(agentId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
      expect(res.body.error.message).toContain(evalId);
      expect(res.body.error.meta).toEqual({
        promotion_gate: evalId,
        agent_version: 2,
      });

      // A blocked promotion changes nothing: the split keeps serving.
      const agent = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agent.body.active_release.canary_version).toBe(2);
      expect(agent.body.instructions).toBe('canary prompt');
    });

    test('a passing run against the canary promotes and links the run', async () => {
      const { agentId, evalId } = await gatedAgent('gate-green');

      const run = await runEval({ evalId, version: 2, answer: 'Paris' });
      expect(run.passed).toBe(true);

      const res = await promote(agentId);

      expect(res.status).toBe(200);
      expect(res.body.active_release).toBeNull();
      expect(res.body.instructions).toBe('canary prompt');

      // The version now live records what validated it — the headline
      // integration with the evaluations module doc.
      expect((await liveVersionRow(agentId)).eval_run_id).toBe(run.id);
    });

    test('a passing run against a different version does not satisfy the gate', async () => {
      const { agentId, evalId } = await gatedAgent('gate-wrong-version');

      // Green — but it measured the stable config, which says nothing about
      // the canary being promoted.
      const run = await runEval({ evalId, version: 1, answer: 'Paris' });
      expect(run.passed).toBe(true);

      const res = await promote(agentId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
    });

    test('a failing run against the canary does not satisfy the gate', async () => {
      const { agentId, evalId } = await gatedAgent('gate-red');

      const run = await runEval({ evalId, version: 2, answer: 'Lyon' });
      expect(run.passed).toBe(false);

      const res = await promote(agentId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
    });

    test('abort is never blocked by an unmet gate', async () => {
      const { agentId } = await gatedAgent('gate-abort');

      // The gate exists to stop a bad canary going live, so it must never trap
      // an operator inside a rollout they want to end.
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/release/abort`
      );

      expect(res.status).toBe(200);
      expect(res.body.active_release).toBeNull();
      expect(res.body.instructions).toBe('stable prompt');
    });

    test('an ungated promotion records no eval run', async () => {
      const agent = await createAgent({ instructions: 'ungated stable' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'ungated canary' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 10 });

      expect((await promote(agent.id)).status).toBe(200);
      expect((await liveVersionRow(agent.id)).eval_run_id).toBeNull();
    });

    test('a gate naming an eval of another agent is rejected', async () => {
      const agent = await createAgent({ instructions: 'gate-foreign stable' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'gate-foreign canary' });

      const other = await createAgent({ instructions: 'a different agent' });
      const foreignEval = await createGateEval('gate-foreign', other.id);

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 10,
          promotion_gate: foreignEval,
        });

      // Rejected at set time rather than stored: an eval of another agent can
      // be green for reasons that say nothing about this config.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain('different agent');
    });

    test('a gate naming an unknown eval is rejected', async () => {
      const agent = await createAgent({ instructions: 'gate-unknown stable' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'gate-unknown canary' });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 10,
          promotion_gate: 'eval_missing',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-string gate is rejected', async () => {
      const agent = await createAgent({ instructions: 'gate-typed stable' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'gate-typed canary' });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 10,
          promotion_gate: 42,
        });

      expect(res.status).toBe(400);
    });

    test('an explicit null gate is an ungated rollout', async () => {
      const agent = await createAgent({ instructions: 'gate-null stable' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'gate-null canary' });

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 10,
          promotion_gate: null,
        });

      expect(res.status).toBe(200);
      expect(res.body.active_release.promotion_gate).toBeNull();
      expect((await promote(agent.id)).status).toBe(200);
    });

    test('re-setting a release can drop the gate', async () => {
      const { agentId } = await gatedAgent('gate-dropped');

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 50 });

      expect(res.status).toBe(200);
      expect(res.body.active_release.promotion_gate).toBeNull();
      // Ungated again, so promotion needs no evidence.
      expect((await promote(agentId)).status).toBe(200);
    });
  });

  describe('release survives further edits', () => {
    test('promote pins the canary config even after the live row moved on', async () => {
      const agent = await createAgent({ instructions: 'v1' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'v2' });
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 50 });

      // A third edit lands while the canary is running — a draft that is
      // neither stable nor canary.
      await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agent.id}`)
        .send({ instructions: 'v3 draft' });

      const promoted = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agent.id}/release/promote`
      );

      expect(promoted.status).toBe(200);
      // Promote means "the canary wins", not "whatever is newest wins".
      expect(promoted.body.instructions).toBe('v2');
      expect(promoted.body.active_release).toBeNull();
    });
  });
});
