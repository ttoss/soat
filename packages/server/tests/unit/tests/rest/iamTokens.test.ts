import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import { flushAuditQueue } from 'src/lib/auditQueue';
import { evaluatePolicies, type PolicyDocument } from 'src/lib/iam';
import { resolveGenerationIdentitySets } from 'src/lib/onBehalfOfIdentity';
import {
  buildRunAuthHeader,
  readStoredRunPrincipal,
  readStoredStartingPrincipal,
  signRunToken,
} from 'src/lib/orchestrationRunToken';
import type { PrincipalBound } from 'src/lib/principalBound';
import { signToken } from 'src/lib/signedTokens';
import { signTriggerToken } from 'src/lib/triggerToken';
import { resolveJwtAuthUser } from 'src/middleware/auth';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * An IAM token is its issuing key held to a bound: every request is checked
 * against the key's grant as it stands ∩ the bound, and work the token starts
 * stores the bound so it holds after the token expires.
 */

const GENERATE_ONLY: PolicyDocument = {
  statement: [{ effect: 'Allow', action: ['agents:CreateAgentGeneration'] }],
};

describe('IAM tokens', () => {
  let turn: AgentToolTurn;
  let key: string;
  let keyId: string;
  let keyPolicyId: string;
  let agentId: string;
  let documentId: string;
  let orchestrationId: string;
  let docsPolicyId: string;
  let builtinTool: { id: string; name: string };
  let builtinAgentId: string;

  const mint = (credential: string, body: Record<string, unknown>) => {
    return authenticatedTestClient(credential)
      .post('/api/v1/iam/tokens')
      .send(body);
  };

  const mintToken = async (body: Record<string, unknown>, from = key) => {
    const res = await mint(from, body);
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const mintKey = async (policyIds: string[]) => {
    const res = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: turn.unique('key'),
        project_id: turn.projectId,
        policy_ids: policyIds,
      });
    expect(res.status).toBe(201);
    return { key: res.body.key as string, id: res.body.id as string };
  };

  const readDocument = (credential: string) => {
    return authenticatedTestClient(credential).get(
      `/api/v1/documents/${documentId}`
    );
  };

  const generate = (credential: string, agent = agentId) => {
    return authenticatedTestClient(credential)
      .post(`/api/v1/agents/${agent}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: '[]' }] });
  };

  const expired = (token: string) => {
    const claims = Object.entries(jwt.decode(token, { json: true }) ?? {});
    const now = Math.floor(Date.now() / 1000);
    return signToken({
      typ: 'iam',
      claims: {
        ...Object.fromEntries(
          claims.filter(([name]) => {
            return name !== 'exp';
          })
        ),
        iat: now - 120,
      },
      expiresIn: 60,
    });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'iamtok' });
    keyPolicyId = await turn.createPolicy({
      statement: [
        {
          effect: 'Allow',
          action: [
            'agents:*',
            'documents:*',
            'orchestrations:*',
            'iam:CreateToken',
          ],
        },
      ],
    });
    ({ key, id: keyId } = await mintKey([keyPolicyId]));
    docsPolicyId = await turn.createPolicy({
      statement: [{ effect: 'Allow', action: ['documents:GetDocument'] }],
    });

    agentId = await turn.createAgent({});
    const doc = await turn
      .api()
      .post('/api/v1/documents')
      .send({ project_id: turn.projectId, content: 'secret' });
    expect(doc.status).toBe(201);
    documentId = doc.body.id;

    builtinTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['get-document'],
    });
    builtinAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: builtinTool.id }],
    });

    const orchestration = await turn
      .api()
      .post('/api/v1/orchestrations')
      .send({
        project_id: turn.projectId,
        name: turn.unique('orch'),
        nodes: [{ id: 'start', type: 'transform', expression: { var: '' } }],
        edges: [],
      });
    expect(orchestration.status).toBe(201);
    orchestrationId = orchestration.body.id;
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('POST /api/v1/iam/tokens', () => {
    test('issues a token and when it expires', async () => {
      const before = Date.now();
      const res = await mint(key, { policy: GENERATE_ONLY, ttl_seconds: 60 });

      expect(res.status).toBe(201);
      expect(typeof res.body.token).toBe('string');
      const expiresAt = Date.parse(res.body.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 59_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
    });

    test('401 without a credential', async () => {
      const res = await testClient
        .post('/api/v1/iam/tokens')
        .send({ policy: GENERATE_ONLY });
      expect(res.status).toBe(401);
    });

    test('403 FORBIDDEN for a key without iam:CreateToken', async () => {
      const agentsOnly = await turn.createPolicy({
        statement: [{ effect: 'Allow', action: ['agents:*'] }],
      });
      const narrow = await mintKey([agentsOnly]);
      const res = await mint(narrow.key, { policy: GENERATE_ONLY });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    describe('403 IAM_TOKEN_ISSUER_NOT_ALLOWED', () => {
      const issuers: Array<[string, () => Promise<string>]> = [
        [
          'a user login',
          async () => {
            return turn.adminToken;
          },
        ],
        [
          'an unscoped key',
          async () => {
            const res = await turn
              .api()
              .post('/api/v1/api-keys')
              .send({ name: turn.unique('unscoped'), project_id: null });
            expect(res.status).toBe(201);
            return res.body.key as string;
          },
        ],
        [
          'an IAM token',
          async () => {
            return mintToken({
              policy: {
                statement: [{ effect: 'Allow', action: ['iam:CreateToken'] }],
              },
            });
          },
        ],
        [
          'a run token',
          async () => {
            const owner = await db.ApiKey.findOne({
              where: { publicId: keyId },
              include: [{ model: db.User }],
            });
            return signRunToken({
              publicId: owner!.user!.publicId as string,
              role: owner!.user!.role as string,
              projectPublicId: turn.projectId,
              workPublicId: 'orn_iamtok',
              apiKeyPublicId: keyId,
            });
          },
        ],
        [
          'a trigger token',
          async () => {
            const owner = await db.ApiKey.findOne({
              where: { publicId: keyId },
              include: [{ model: db.User }],
            });
            return signTriggerToken({
              publicId: owner!.user!.publicId as string,
              role: owner!.user!.role as string,
              projectPublicId: turn.projectId,
              triggerId: 'trg_iamtok',
            });
          },
        ],
      ];

      test.each(issuers)('for %s', async (_, credential) => {
        const res = await mint(await credential(), { policy: GENERATE_ONLY });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('IAM_TOKEN_ISSUER_NOT_ALLOWED');
      });
    });

    test('400 IAM_TOKEN_POLICY_INVALID for a malformed policy', async () => {
      const res = await mint(key, {
        policy: { statement: [{ effect: 'Maybe', action: ['agents:*'] }] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IAM_TOKEN_POLICY_INVALID');
    });

    test('400 IAM_TOKEN_POLICY_INVALID for an unknown policy id', async () => {
      const res = await mint(key, { policy_ids: ['pol_doesnotexist'] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IAM_TOKEN_POLICY_INVALID');
    });

    test('400 VALIDATION_FAILED for both policy and policy_ids', async () => {
      const res = await mint(key, {
        policy: GENERATE_ONLY,
        policy_ids: [docsPolicyId],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 VALIDATION_FAILED for neither policy nor policy_ids', async () => {
      const res = await mint(key, { ttl_seconds: 60 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test.each([10, 3600])(
      '400 VALIDATION_FAILED for ttl_seconds %d',
      async (ttl) => {
        const res = await mint(key, {
          policy: GENERATE_ONLY,
          ttl_seconds: ttl,
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    );
  });

  describe('a request on an IAM token', () => {
    test('is held to the bound: 403 on a document the key reads, 2xx on a generation', async () => {
      const token = await mintToken({ policy: GENERATE_ONLY });

      expect((await readDocument(key)).status).toBe(200);
      const read = await readDocument(token);
      expect(read.status).toBe(403);
      expect((await generate(token)).status).toBe(200);
    });

    test('a denial by the bound names the token, not the key', async () => {
      const token = await mintToken({ policy: GENERATE_ONLY });
      const { jti } = jwt.decode(token, { json: true }) ?? {};
      const resource = `srn:${turn.projectId}:document:${documentId}`;

      const read = await readDocument(token);

      expect(read.body.error).toMatchObject({
        message: `Forbidden: IAM token ${jti}'s policies deny documents:GetDocument on ${resource}`,
        meta: { denied_by: { type: 'iam_token', id: jti } },
      });
    });

    test("a denial by the key's own policies names the key", async () => {
      const token = await mintToken({
        policy: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });

      const res = await authenticatedTestClient(token).get(
        `/api/v1/tools?project_id=${turn.projectId}`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_by).toEqual({
        type: 'api_key',
        id: keyId,
      });
    });

    test('a policy_ids bound is read by id', async () => {
      const token = await mintToken({ policy_ids: [docsPolicyId] });

      expect((await readDocument(token)).status).toBe(200);
      expect((await generate(token)).status).toBe(403);
    });

    test('an Allow beyond the key grants nothing', async () => {
      const docsAndTokens = await turn.createPolicy({
        statement: [
          {
            effect: 'Allow',
            action: ['documents:GetDocument', 'iam:CreateToken'],
          },
        ],
      });
      const narrow = await mintKey([docsAndTokens]);
      const token = await mintToken(
        { policy: { statement: [{ effect: 'Allow', action: ['*'] }] } },
        narrow.key
      );

      expect((await readDocument(token)).status).toBe(200);
      expect((await generate(token)).status).toBe(403);
    });

    test('a permission removed from the key leaves a live token', async () => {
      const own = await turn.createPolicy({
        statement: [
          {
            effect: 'Allow',
            action: ['agents:CreateAgentGeneration', 'iam:CreateToken'],
          },
        ],
      });
      const issuing = await mintKey([own]);
      const token = await mintToken({ policy: GENERATE_ONLY }, issuing.key);
      expect((await generate(token)).status).toBe(200);

      const update = await turn
        .api()
        .put(`/api/v1/policies/${own}`)
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['iam:CreateToken'] }],
          },
        });
      expect(update.status).toBe(200);

      expect((await generate(token)).status).toBe(403);
    });

    test('401 once the token has expired', async () => {
      const token = await mintToken({ policy: GENERATE_ONLY });
      const res = await generate(expired(token));
      expect(res.status).toBe(401);
    });

    test('403 API_KEY_SCOPED_TOKEN: a token creates no API key', async () => {
      const token = await mintToken({
        policy: { statement: [{ effect: 'Allow', action: ['*'] }] },
      });
      const res = await authenticatedTestClient(token)
        .post('/api/v1/api-keys')
        .send({ name: turn.unique('fromtoken') });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_SCOPED_TOKEN');
    });

    test('the audit log names the key and records the token id and principal', async () => {
      const token = await mintToken({
        policy: GENERATE_ONLY,
        principal: { type: 'mcp_server', id: 'srv_audit' },
      });
      const jti = (jwt.decode(token) as { jti: string }).jti;
      const res = await generate(token);
      expect(res.status).toBe(200);

      await flushAuditQueue();
      const entries = await turn
        .api()
        .get('/api/v1/audit-log')
        .query({ project_id: turn.projectId, principal_id: keyId });
      expect(entries.status).toBe(200);
      const entry = (
        entries.body.data as Array<{ detail: Record<string, unknown> | null }>
      ).find((candidate) => {
        return (
          (candidate.detail?.iam_token as { jti?: string } | undefined)?.jti ===
          jti
        );
      });
      expect(entry?.detail?.iam_token).toEqual({
        jti,
        principal: { type: 'mcp_server', id: 'srv_audit' },
      });
    });
  });

  describe('work started on an IAM token keeps its bound', () => {
    test("the turn's builtin call cannot read a document the key can", async () => {
      const readThroughTurn = async (credential: string) => {
        const res = await authenticatedTestClient(credential)
          .post(`/api/v1/agents/${builtinAgentId}/generate?wait=true`)
          .send({
            messages: [
              {
                role: 'user',
                content: JSON.stringify({
                  calls: [
                    {
                      name: `${builtinTool.name}_get-document`,
                      args: { document_id: documentId },
                    },
                  ],
                }),
              },
            ],
          });
        expect(res.status).toBe(200);
        return JSON.parse(res.body.output.content)[0];
      };
      const token = await mintToken({ policy: GENERATE_ONLY });

      expect((await readThroughTurn(key)).id).toBe(documentId);
      expect(await readThroughTurn(token)).toMatch(
        /^DomainError: Forbidden: IAM token \S+'s policies deny documents:GetDocument on srn:/
      );
    });

    test('a generation stores the bound, and its re-minted credential cannot read a document after the token expires', async () => {
      const token = await mintToken({ policy: GENERATE_ONLY, ttl_seconds: 30 });
      const res = await generate(token);
      expect(res.status).toBe(200);

      const gen = await db.Generation.findOne({
        where: { publicId: res.body.id },
      });
      expect(gen!.actedAsPrincipalId).toBe(keyId);
      expect(gen!.actedAsPrincipalBound).toEqual({ policy: GENERATE_ONLY });

      const header = await buildRunAuthHeader({
        principal: readStoredStartingPrincipal({
          kind: gen!.actedAsPrincipalType,
          id: gen!.actedAsPrincipalId,
          bound: gen!.actedAsPrincipalBound,
        }),
        projectId: gen!.projectId as number,
        workPublicId: res.body.id,
      });
      const background = header!.slice('Bearer '.length);
      expect((await readDocument(background)).status).toBe(403);
      expect((await generate(background)).status).toBe(200);

      const identity = await resolveGenerationIdentitySets({
        generationPublicId: res.body.id,
        projectPublicId: turn.projectId,
      });
      const readsDocument = identity.every((policies) => {
        return evaluatePolicies({
          policies,
          action: 'documents:GetDocument',
          resource: `srn:${turn.projectId}:document:${documentId}`,
        });
      });
      expect(readsDocument).toBe(false);
    });

    test("a trigger fired on a token acts inside the token's bound", async () => {
      const owner = await db.ApiKey.findOne({
        where: { publicId: keyId },
        include: [{ model: db.User }],
      });
      const everything = { statement: [{ effect: 'Allow', action: ['*'] }] };
      const trigger = await turn
        .api()
        .post('/api/v1/triggers')
        .send({
          policy_ids: [await turn.createPolicy(everything)],
          project_id: turn.projectId,
          name: turn.unique('trigger'),
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
        });
      expect(trigger.status).toBe(201);
      const readsDocument = async (bound?: PrincipalBound) => {
        const token = signTriggerToken({
          publicId: owner!.user!.publicId as string,
          role: owner!.user!.role as string,
          projectPublicId: turn.projectId,
          triggerId: trigger.body.id,
          caller: { apiKeyPublicId: keyId, ...(bound ? { bound } : {}) },
        });
        const authUser = await resolveJwtAuthUser({ db, token });
        return authUser!.isAllowed({
          projectPublicId: turn.projectId,
          action: 'documents:GetDocument',
          resource: `srn:${turn.projectId}:document:${documentId}`,
        });
      };

      expect(await readsDocument()).toBe(true);
      expect(await readsDocument({ policy: GENERATE_ONLY })).toBe(false);
    });

    test('an orchestration run stores the bound', async () => {
      const token = await mintToken({ policy_ids: [keyPolicyId] });
      const res = await authenticatedTestClient(token)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId });
      expect(res.status).toBe(201);

      const run = await db.OrchestrationRun.findOne({
        where: { publicId: res.body.id },
      });
      expect(readStoredRunPrincipal(run)).toEqual({
        principalType: 'api_key',
        principalId: keyId,
        bound: { policyIds: [keyPolicyId] },
      });
    });

    test('a stored bound that no longer parses yields no principal', () => {
      expect(
        readStoredStartingPrincipal({
          kind: 'api_key',
          id: keyId,
          bound: { policy: { statement: 'nope' } },
        })
      ).toBeNull();
    });
  });
});
