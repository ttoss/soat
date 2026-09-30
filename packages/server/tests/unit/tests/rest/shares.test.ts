import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Shares', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let publisherId: string;
  let granteeId: string;
  let thirdId: string;
  let publisherKey: string;
  let granteeKey: string;
  let aiProviderId: string;

  const srn = (args: { type: string; id: string; project?: string }) => {
    return `srn:${args.project ?? publisherId}:${args.type}:${args.id}`;
  };

  const createTool = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name,
        type: 'client',
        description: 'Reads text off an image',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
        },
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: publisherId,
        ai_provider_id: aiProviderId,
        name,
        instructions: 'Extract all text verbatim.',
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createShare = async (
    overrides: Record<string, unknown> & { resource: string }
  ) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        actions: ['tools:CallTool'],
        grantee: granteeId,
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; resource: string };
  };

  const createToolShare = async (name: string) => {
    const toolId = await createTool(name);
    const share = await createShare({
      resource: srn({ type: 'tool', id: toolId }),
    });
    return { toolId, shareId: share.id };
  };

  const accept = (shareId: string, key: string = granteeKey) => {
    return authenticatedTestClient(key).post(
      `/api/v1/shares/${shareId}/accept`
    );
  };

  const activityOf = async (args: {
    projectId: string;
    kind: string;
    shareId: string;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/activity')
      .query({ project_id: args.projectId, kind: args.kind });
    expect(res.status).toBe(200);
    return (
      res.body.data as Array<{
        ref_id: string;
        severity: string;
        detail: Record<string, unknown>;
      }>
    ).filter((entry) => {
      return entry.ref_id === args.shareId;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'shares',
      policyActions: [
        'shares:CreateShare',
        'shares:ListShares',
        'shares:GetShare',
        'shares:AcceptShare',
        'shares:SuspendShare',
        'shares:RevokeShare',
        'shares:DeleteShare',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    publisherId = setup.projectId;
    granteeId = setup.otherProjectId as string;

    const thirdRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'shares Third Project' });
    thirdId = thirdRes.body.id;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: publisherId,
        name: 'Shares Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = providerRes.body.id;

    const mintKey = async (projectId: string): Promise<string> => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: `Shares key ${projectId}`, project_id: projectId });
      expect(res.status).toBe(201);
      return res.body.key;
    };
    publisherKey = await mintKey(publisherId);
    granteeKey = await mintKey(granteeId);
  });

  describe('POST /api/v1/shares', () => {
    test('creates a tool share with the grantee projection', async () => {
      const toolId = await createTool('create-share-tool');

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'tool', id: toolId }),
          actions: ['tools:CallTool'],
          grantee: granteeId,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^shr_/);
      expect(res.body.project_id).toBe(publisherId);
      expect(res.body.resource).toBe(srn({ type: 'tool', id: toolId }));
      expect(res.body.actions).toEqual(['tools:CallTool']);
      expect(res.body.grantee).toBe(granteeId);
      expect(res.body.suspended_at).toBeNull();
      expect(res.body.revoked_at).toBeNull();
      expect(res.body.acceptance).toBeUndefined();
      expect(res.body.projection).toEqual({
        id: toolId,
        name: 'create-share-tool',
        description: 'Reads text off an image',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
        },
      });
    });

    test('an agent projection carries no instructions or provider', async () => {
      const agentId = await createAgent('create-share-agent');

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'agent', id: agentId }),
          actions: ['agents:CreateAgentGeneration'],
          grantee: granteeId,
        });

      expect(res.status).toBe(201);
      expect(res.body.projection).toEqual({
        id: agentId,
        name: 'create-share-agent',
      });
    });

    test('a scoped key creates a share for its own project', async () => {
      const toolId = await createTool('scoped-key-share-tool');

      const res = await authenticatedTestClient(publisherKey)
        .post('/api/v1/shares')
        .send({
          resource: srn({ type: 'tool', id: toolId }),
          actions: ['tools:CallTool'],
          grantee: granteeId,
        });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(publisherId);
    });

    test('a scoped key is refused for another project', async () => {
      const res = await authenticatedTestClient(publisherKey)
        .post('/api/v1/shares')
        .send({
          project_id: granteeId,
          resource: srn({ type: 'tool', id: 'tool_x', project: granteeId }),
          actions: ['tools:CallTool'],
          grantee: thirdId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });

    test('a resource in another project is 400', async () => {
      const toolId = await createTool('foreign-srn-tool');

      const res = await authenticatedTestClient(publisherKey)
        .post('/api/v1/shares')
        .send({
          resource: srn({ type: 'tool', id: toolId, project: granteeId }),
          actions: ['tools:CallTool'],
          grantee: thirdId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test.each([
      ['a write action', ['tools:UpdateTool']],
      ["another type's action", ['agents:CreateAgentGeneration']],
      ['one refused action among granted ones', ['tools:CallTool', '*']],
    ])('an action outside the registry is 400: %s', async (_, actions) => {
      const toolId = await createTool(`bad-action-tool-${actions.join('-')}`);

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'tool', id: toolId }),
          actions,
          grantee: granteeId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.field).toBe('actions');
    });

    test.each([
      ['a wildcard resource', 'tool:*'],
      ['a type that cannot be shared', 'secret:sec_abc'],
      ['a malformed SRN', 'tool'],
    ])('%s is 400', async (_, suffix) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: `srn:${publisherId}:${suffix}`,
          actions: ['tools:CallTool'],
          grantee: granteeId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a resource that does not exist is 400 TOOL_NOT_FOUND', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'tool', id: 'tool_doesnotexist0000' }),
          actions: ['tools:CallTool'],
          grantee: granteeId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test.each([
      [
        'the publisher itself',
        () => {
          return publisherId;
        },
      ],
      [
        'a value that is not a project id',
        () => {
          return 'everyone';
        },
      ],
    ])('grantee %s is 400', async (_, grantee) => {
      const toolId = await createTool(`bad-grantee-tool-${grantee()}`);

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'tool', id: toolId }),
          actions: ['tools:CallTool'],
          grantee: grantee(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.field).toBe('grantee');
    });

    test('"*" is refused without SHARES_ALLOW_PUBLIC', async () => {
      const toolId = await createTool('public-refused-tool');

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'tool', id: toolId }),
          actions: ['tools:CallTool'],
          grantee: '*',
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PUBLIC_SHARES_DISABLED');
    });

    test('"*" is accepted with SHARES_ALLOW_PUBLIC=true', async () => {
      const toolId = await createTool('public-allowed-tool');
      process.env.SHARES_ALLOW_PUBLIC = 'true';
      try {
        const res = await authenticatedTestClient(adminToken)
          .post('/api/v1/shares')
          .send({
            project_id: publisherId,
            resource: srn({ type: 'tool', id: toolId }),
            actions: ['tools:CallTool'],
            grantee: '*',
          });

        expect(res.status).toBe(201);
        expect(res.body.grantee).toBe('*');
      } finally {
        delete process.env.SHARES_ALLOW_PUBLIC;
      }
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/shares').send({
        project_id: publisherId,
        resource: srn({ type: 'tool', id: 'tool_x' }),
        actions: ['tools:CallTool'],
        grantee: granteeId,
      });

      expect(res.status).toBe(401);
    });

    test('a user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: srn({ type: 'tool', id: 'tool_x' }),
          actions: ['tools:CallTool'],
          grantee: granteeId,
        });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/shares/:share_id', () => {
    test('the publisher reads its share without an acceptance', async () => {
      const { shareId } = await createToolShare('get-publisher-tool');

      const res = await authenticatedTestClient(publisherKey).get(
        `/api/v1/shares/${shareId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(shareId);
      expect(res.body.acceptance).toBeUndefined();
      expect(res.body.projection.name).toBe('get-publisher-tool');
    });

    test('the grantee reads it with its own acceptance', async () => {
      const { shareId } = await createToolShare('get-grantee-tool');

      const before = await authenticatedTestClient(granteeKey).get(
        `/api/v1/shares/${shareId}`
      );
      expect(before.status).toBe(200);
      expect(before.body.acceptance).toBeNull();
      expect(before.body.projection.name).toBe('get-grantee-tool');
      expect(before.body.projection.execute).toBeUndefined();

      await accept(shareId);
      const after = await authenticatedTestClient(adminToken)
        .get(`/api/v1/shares/${shareId}`)
        .query({ project_id: granteeId });
      expect(after.body.acceptance.status).toBe('active');
      expect(after.body.acceptance.project_id).toBe(granteeId);
    });

    test('a project the share is not addressed to gets 404', async () => {
      const { shareId } = await createToolShare('get-third-tool');

      const res = await authenticatedTestClient(adminToken)
        .get(`/api/v1/shares/${shareId}`)
        .query({ project_id: thirdId });

      expect(res.status).toBe(404);
    });

    test('a user without permission gets 404', async () => {
      const { shareId } = await createToolShare('get-noperm-tool');

      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/shares/${shareId}`
      );

      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/shares/shr_x');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/shares', () => {
    test('lists the published shares, filtered by resource', async () => {
      const { shareId, toolId } = await createToolShare('list-publisher-tool');

      const res = await authenticatedTestClient(publisherKey)
        .get('/api/v1/shares')
        .query({ resource: srn({ type: 'tool', id: toolId }) });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe(shareId);
    });

    test('lists the received shares with the acceptance', async () => {
      const { shareId } = await createToolShare('list-grantee-tool');
      await accept(shareId);

      const res = await authenticatedTestClient(granteeKey)
        .get('/api/v1/shares')
        .query({ role: 'grantee' });

      expect(res.status).toBe(200);
      const item = res.body.data.find((share: { id: string }) => {
        return share.id === shareId;
      });
      expect(item.acceptance.status).toBe('active');
      expect(item.projection).toBeUndefined();
    });

    test('a project receives nothing addressed to another', async () => {
      await createToolShare('list-third-tool');

      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/shares')
        .query({ role: 'grantee', project_id: thirdId });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    test('role=grantee with no project is 400', async () => {
      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/shares')
        .query({ role: 'grantee' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/shares');
      expect(res.status).toBe(401);
    });

    test('a user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/shares')
        .query({ project_id: publisherId });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/shares/:share_id/accept', () => {
    test('an unaccepted share has no acceptance row', async () => {
      const { shareId } = await createToolShare('unaccepted-tool');

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}/acceptances`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    test('the grantee accepts, idempotently', async () => {
      const { shareId } = await createToolShare('accept-tool');

      const first = await accept(shareId);
      expect(first.status).toBe(200);
      expect(first.body.id).toMatch(/^shr_acc_/);
      expect(first.body.share_id).toBe(shareId);
      expect(first.body.project_id).toBe(granteeId);
      expect(first.body.status).toBe('active');
      expect(first.body.revoked_by).toBeNull();

      const second = await accept(shareId);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);

      const list = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}/acceptances`
      );
      expect(list.body.total).toBe(1);
    });

    test('concurrent accepts converge on one acceptance', async () => {
      const { shareId } = await createToolShare('accept-concurrent-tool');

      const responses = await Promise.all([accept(shareId), accept(shareId)]);

      expect(
        responses.map((res) => {
          return res.status;
        })
      ).toEqual([200, 200]);
      expect(responses[0].body.id).toBe(responses[1].body.id);
    });

    test('any project accepts a public share', async () => {
      const toolId = await createTool('accept-public-tool');
      process.env.SHARES_ALLOW_PUBLIC = 'true';
      let shareId: string;
      try {
        ({ id: shareId } = await createShare({
          resource: srn({ type: 'tool', id: toolId }),
          grantee: '*',
        }));
      } finally {
        delete process.env.SHARES_ALLOW_PUBLIC;
      }

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/shares/${shareId}/accept`)
        .send({ project_id: thirdId });

      expect(res.status).toBe(200);
      expect(res.body.project_id).toBe(thirdId);
    });

    test('a project the share is not addressed to gets 404', async () => {
      const { shareId } = await createToolShare('accept-third-tool');

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/shares/${shareId}/accept`)
        .send({ project_id: thirdId });

      expect(res.status).toBe(404);
    });

    test('the publisher accepting its own share is 400', async () => {
      const { shareId } = await createToolShare('accept-own-tool');

      const res = await accept(shareId, publisherKey);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('with no accepting project it is 400', async () => {
      const { shareId } = await createToolShare('accept-noproject-tool');

      const res = await accept(shareId, adminToken);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a grantee principal without AcceptShare gets 403', async () => {
      const { shareId } = await createToolShare('accept-forbidden-tool');
      const token = await createScopedPrincipal({
        adminToken,
        projectId: granteeId,
        username: 'sharesreader',
        actions: ['shares:GetShare'],
      });

      const res = await authenticatedTestClient(token)
        .post(`/api/v1/shares/${shareId}/accept`)
        .send({ project_id: granteeId });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/shares/shr_x/accept');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/shares/:share_id/suspend and /resume', () => {
    test('suspend keeps the acceptance and resume needs no re-accept', async () => {
      const { shareId } = await createToolShare('suspend-tool');
      const accepted = await accept(shareId);

      const suspended = await authenticatedTestClient(publisherKey).post(
        `/api/v1/shares/${shareId}/suspend`
      );
      expect(suspended.status).toBe(200);
      expect(suspended.body.suspended_at).not.toBeNull();

      const during = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}/acceptances`
      );
      expect(during.body.data).toEqual([
        expect.objectContaining({ id: accepted.body.id, status: 'active' }),
      ]);

      const resumed = await authenticatedTestClient(publisherKey).post(
        `/api/v1/shares/${shareId}/resume`
      );
      expect(resumed.status).toBe(200);
      expect(resumed.body.suspended_at).toBeNull();

      const after = await authenticatedTestClient(granteeKey).get(
        `/api/v1/shares/${shareId}`
      );
      expect(after.body.acceptance.id).toBe(accepted.body.id);
      expect(after.body.acceptance.status).toBe('active');
    });

    test('each writes one entry in the consumer project', async () => {
      const { shareId, toolId } = await createToolShare(
        'suspend-activity-tool'
      );
      await accept(shareId);

      for (const verb of ['suspend', 'suspend', 'resume']) {
        await authenticatedTestClient(adminToken).post(
          `/api/v1/shares/${shareId}/${verb}`
        );
      }

      const suspended = await activityOf({
        projectId: granteeId,
        kind: 'share_suspended',
        shareId,
      });
      expect(suspended).toHaveLength(1);
      expect(suspended[0].severity).toBe('warning');
      expect(suspended[0].detail).toEqual({
        share_id: shareId,
        resource: srn({ type: 'tool', id: toolId }),
        publisher_project_id: publisherId,
      });
      expect(
        await activityOf({
          projectId: granteeId,
          kind: 'share_resumed',
          shareId,
        })
      ).toHaveLength(1);
    });

    test('the grantee cannot suspend', async () => {
      const { shareId } = await createToolShare('suspend-grantee-tool');

      const res = await authenticatedTestClient(granteeKey).post(
        `/api/v1/shares/${shareId}/suspend`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });

    test('a publisher principal without SuspendShare gets 403', async () => {
      const { shareId } = await createToolShare('suspend-forbidden-tool');
      const token = await createScopedPrincipal({
        adminToken,
        projectId: publisherId,
        username: 'sharessuspendreader',
        actions: ['shares:GetShare'],
      });

      const res = await authenticatedTestClient(token).post(
        `/api/v1/shares/${shareId}/suspend`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/shares/shr_x/suspend');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/shares/:share_id/revoke', () => {
    test('a consumer revoke lets the consumer accept again', async () => {
      const { shareId } = await createToolShare('consumer-revoke-tool');
      await accept(shareId);

      const revoked = await authenticatedTestClient(granteeKey).post(
        `/api/v1/shares/${shareId}/revoke`
      );
      expect(revoked.status).toBe(200);
      expect(revoked.body.revoked_at).toBeNull();
      expect(revoked.body.acceptance.status).toBe('revoked');
      expect(revoked.body.acceptance.revoked_by).toBe('consumer');

      const again = await accept(shareId);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('active');
      expect(again.body.revoked_by).toBeNull();
    });

    test('a consumer that never accepted gets 404', async () => {
      const { shareId } = await createToolShare('consumer-revoke-none-tool');

      const res = await authenticatedTestClient(granteeKey).post(
        `/api/v1/shares/${shareId}/revoke`
      );

      expect(res.status).toBe(404);
    });

    test('a publisher revoke is terminal and tells the consumer', async () => {
      const { shareId } = await createToolShare('publisher-revoke-tool');
      await accept(shareId);

      const res = await authenticatedTestClient(publisherKey).post(
        `/api/v1/shares/${shareId}/revoke`
      );
      expect(res.status).toBe(200);
      expect(res.body.revoked_at).not.toBeNull();

      const acceptances = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}/acceptances`
      );
      expect(acceptances.body.data[0]).toEqual(
        expect.objectContaining({ status: 'revoked', revoked_by: 'publisher' })
      );

      const reaccept = await accept(shareId);
      expect(reaccept.status).toBe(403);
      expect(reaccept.body.error.code).toBe('SHARE_REVOKED');

      const resume = await authenticatedTestClient(publisherKey).post(
        `/api/v1/shares/${shareId}/resume`
      );
      expect(resume.status).toBe(403);
      expect(resume.body.error.code).toBe('SHARE_REVOKED');

      expect(
        await activityOf({
          projectId: granteeId,
          kind: 'share_revoked',
          shareId,
        })
      ).toHaveLength(1);
    });

    test('a grantee principal without RevokeShare gets 403', async () => {
      const { shareId } = await createToolShare('revoke-forbidden-tool');
      await accept(shareId);
      const token = await createScopedPrincipal({
        adminToken,
        projectId: granteeId,
        username: 'sharesrevokereader',
        actions: ['shares:GetShare'],
      });

      const res = await authenticatedTestClient(token)
        .post(`/api/v1/shares/${shareId}/revoke`)
        .send({ project_id: granteeId });

      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/shares/shr_x/revoke');
      expect(res.status).toBe(401);
    });
  });

  describe('acceptances', () => {
    test('a publisher-revoked acceptance refuses re-accept until deleted', async () => {
      const { shareId } = await createToolShare('cut-consumer-tool');
      const accepted = await accept(shareId);

      const revoked = await authenticatedTestClient(publisherKey).post(
        `/api/v1/shares/${shareId}/acceptances/${accepted.body.id}/revoke`
      );
      expect(revoked.status).toBe(200);
      expect(revoked.body.status).toBe('revoked');
      expect(revoked.body.revoked_by).toBe('publisher');
      expect(
        await activityOf({
          projectId: granteeId,
          kind: 'share_revoked',
          shareId,
        })
      ).toHaveLength(1);

      const refused = await accept(shareId);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('SHARE_REVOKED');

      const deleted = await authenticatedTestClient(publisherKey).delete(
        `/api/v1/shares/${shareId}/acceptances/${accepted.body.id}`
      );
      expect(deleted.status).toBe(204);

      const again = await accept(shareId);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('active');
    });

    test('deleting an active acceptance tells the consumer', async () => {
      const { shareId } = await createToolShare('delete-active-acceptance');
      const accepted = await accept(shareId);

      const res = await authenticatedTestClient(publisherKey).delete(
        `/api/v1/shares/${shareId}/acceptances/${accepted.body.id}`
      );

      expect(res.status).toBe(204);
      expect(
        await activityOf({
          projectId: granteeId,
          kind: 'share_revoked',
          shareId,
        })
      ).toHaveLength(1);
    });

    test('lists acceptances filtered by status', async () => {
      const { shareId } = await createToolShare('list-acceptances-tool');
      await accept(shareId);

      const active = await authenticatedTestClient(adminToken)
        .get(`/api/v1/shares/${shareId}/acceptances`)
        .query({ status: 'active' });
      const revoked = await authenticatedTestClient(adminToken)
        .get(`/api/v1/shares/${shareId}/acceptances`)
        .query({ status: 'revoked' });

      expect(active.body.total).toBe(1);
      expect(revoked.body.total).toBe(0);
    });

    test('an acceptance of another share is 404', async () => {
      const first = await createToolShare('acceptance-mismatch-a');
      const second = await createToolShare('acceptance-mismatch-b');
      const accepted = await accept(first.shareId);

      const res = await authenticatedTestClient(adminToken).post(
        `/api/v1/shares/${second.shareId}/acceptances/${accepted.body.id}/revoke`
      );

      expect(res.status).toBe(404);
    });

    test('the grantee cannot list acceptances', async () => {
      const { shareId } = await createToolShare('acceptances-grantee-tool');

      const res = await authenticatedTestClient(granteeKey).get(
        `/api/v1/shares/${shareId}/acceptances`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_PROJECT_SCOPE');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/shares/shr_x/acceptances');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/shares/:share_id', () => {
    test('deletes the share and tells the consumer', async () => {
      const { shareId } = await createToolShare('delete-share-tool');
      await accept(shareId);

      const res = await authenticatedTestClient(publisherKey).delete(
        `/api/v1/shares/${shareId}`
      );
      expect(res.status).toBe(204);

      const get = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}`
      );
      expect(get.status).toBe(404);
      expect(
        await activityOf({
          projectId: granteeId,
          kind: 'share_revoked',
          shareId,
        })
      ).toHaveLength(1);
    });

    test('a user without permission gets 404', async () => {
      const { shareId } = await createToolShare('delete-noperm-tool');

      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/shares/${shareId}`
      );

      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.delete('/api/v1/shares/shr_x');
      expect(res.status).toBe(401);
    });
  });

  describe('accepted shares are dependents', () => {
    test('a tool delete is 409 until force=true revokes the shares', async () => {
      const { toolId, shareId } = await createToolShare('dependent-tool');
      await accept(shareId);

      const refused = await authenticatedTestClient(adminToken).delete(
        `/api/v1/tools/${toolId}`
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('TOOL_HAS_DEPENDENTS');
      expect(refused.body.error.meta.accepted_share_count).toBe(1);

      const forced = await authenticatedTestClient(adminToken)
        .delete(`/api/v1/tools/${toolId}`)
        .query({ force: 'true' });
      expect(forced.status).toBe(204);

      const share = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}`
      );
      expect(share.body.revoked_at).not.toBeNull();
      expect(share.body.projection).toBeNull();
      expect(
        await activityOf({
          projectId: granteeId,
          kind: 'share_revoked',
          shareId,
        })
      ).toHaveLength(1);
    });

    test('a tool whose share nobody accepted deletes and revokes it', async () => {
      const { toolId, shareId } = await createToolShare('unaccepted-dep-tool');

      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/tools/${toolId}`
      );
      expect(res.status).toBe(204);

      const share = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}`
      );
      expect(share.body.revoked_at).not.toBeNull();
    });

    test('an agent delete is 409 until force=true revokes the shares', async () => {
      const agentId = await createAgent('dependent-agent');
      const { id: shareId } = await createShare({
        resource: srn({ type: 'agent', id: agentId }),
        actions: ['agents:CreateAgentGeneration'],
      });
      await accept(shareId);

      const refused = await authenticatedTestClient(adminToken).delete(
        `/api/v1/agents/${agentId}`
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('AGENT_HAS_DEPENDENTS');
      expect(refused.body.error.meta.accepted_share_count).toBe(1);

      const forced = await authenticatedTestClient(adminToken)
        .delete(`/api/v1/agents/${agentId}`)
        .query({ force: 'true' });
      expect(forced.status).toBe(204);

      const share = await authenticatedTestClient(adminToken).get(
        `/api/v1/shares/${shareId}`
      );
      expect(share.body.revoked_at).not.toBeNull();
    });
  });
});
