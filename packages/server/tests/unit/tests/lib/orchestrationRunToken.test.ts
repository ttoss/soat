import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import {
  buildRunAuthHeader,
  readRunTokenPrincipal,
  resolveStartingPrincipal,
  signRunToken,
} from 'src/lib/orchestrationRunToken';
import { JWT_SECRET } from 'src/middleware/auth';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Direct tests for the run-as token seam. The happy paths are covered end to
 * end through the REST entry point in `rest/soatSelfCall.test.ts`; what lives
 * here is the set of branches no entry point can reach — a principal that has
 * been deleted or revoked *after* the run started, and tokens minted by other
 * parts of the platform that must not be mistaken for run tokens.
 */
describe('orchestration run-as token', () => {
  let adminToken: string;
  let projectId: string;
  let projectPk: number;
  let userPublicId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'runtoken',
      policyActions: ['tools:ListTools'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    userPublicId = setup.userId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectPk = project!.id as number;
  });

  describe('buildRunAuthHeader', () => {
    test('mints a token for a user principal', async () => {
      const header = await buildRunAuthHeader({
        principalKind: 'user',
        principalId: userPublicId,
        projectId: projectPk,
        workPublicId: 'orun_test1',
      });
      expect(header).toMatch(/^Bearer /);
      const payload = jwt.verify(header!.slice(7), JWT_SECRET) as {
        publicId: string;
        prj: string;
        orn: string;
        key?: string;
      };
      expect(payload.publicId).toBe(userPublicId);
      expect(payload.prj).toBe(projectId);
      expect(payload.orn).toBe('orun_test1');
      expect(payload.key).toBeUndefined();
    });

    test('carries the API key as a boundary claim for a key principal', async () => {
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ project_id: projectId, name: 'runtoken-key' });
      expect(keyRes.status).toBe(201);

      const header = await buildRunAuthHeader({
        principalKind: 'api_key',
        principalId: keyRes.body.id,
        projectId: projectPk,
        workPublicId: 'orun_test2',
      });
      const payload = jwt.verify(header!.slice(7), JWT_SECRET) as {
        key?: string;
      };
      expect(payload.key).toBe(keyRes.body.id);
    });

    test('a run with no principal gets no header', async () => {
      await expect(
        buildRunAuthHeader({
          principalKind: null,
          principalId: null,
          projectId: projectPk,
          workPublicId: 'orun_test3',
        })
      ).resolves.toBeUndefined();
    });

    test('a revoked API key stops the run acting, rather than falling back to its owner', async () => {
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ project_id: projectId, name: 'runtoken-revoked' });
      expect(keyRes.status).toBe(201);
      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/api-keys/${keyRes.body.id}`
      );
      expect(deleteRes.status).toBe(204);

      // Falling back to an owner-scoped token here would silently widen the
      // run's reach to everything that user can do.
      await expect(
        buildRunAuthHeader({
          principalKind: 'api_key',
          principalId: keyRes.body.id,
          projectId: projectPk,
          workPublicId: 'orun_test4',
        })
      ).resolves.toBeUndefined();
    });

    test('a deleted user stops the run acting', async () => {
      await expect(
        buildRunAuthHeader({
          principalKind: 'user',
          principalId: 'user_goneforever',
          projectId: projectPk,
          workPublicId: 'orun_test5',
        })
      ).resolves.toBeUndefined();
    });

    test('an unknown project yields no header', async () => {
      await expect(
        buildRunAuthHeader({
          principalKind: 'user',
          principalId: userPublicId,
          projectId: -1,
          workPublicId: 'orun_test6',
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('readRunTokenPrincipal', () => {
    const bearer = (claims: Record<string, unknown>): string => {
      return `Bearer ${jwt.sign(claims, JWT_SECRET, { expiresIn: '5m' })}`;
    };

    test('reads back the user principal a run token was minted with', () => {
      const header = `Bearer ${signRunToken({
        publicId: userPublicId,
        role: 'user',
        projectPublicId: projectId,
        workPublicId: 'orun_read1',
      })}`;
      expect(readRunTokenPrincipal(header)).toEqual({
        principalType: 'user',
        principalId: userPublicId,
      });
    });

    test('reads back the key principal, not the owning user', () => {
      const header = `Bearer ${signRunToken({
        publicId: userPublicId,
        role: 'user',
        projectPublicId: projectId,
        workPublicId: 'orun_read2',
        apiKeyPublicId: 'key_abc',
      })}`;
      expect(readRunTokenPrincipal(header)).toEqual({
        principalType: 'api_key',
        principalId: 'key_abc',
      });
    });

    test('a trigger run-as token is not inherited', () => {
      // Its boundary is the trigger's policy, which lives in the token — a
      // re-minted run token would drop it and widen the run's access.
      const header = bearer({
        publicId: userPublicId,
        role: 'user',
        prj: projectId,
        trg: 'trg_abc',
      });
      expect(readRunTokenPrincipal(header)).toBeNull();
    });

    test('an OAuth access token is not inherited', () => {
      const header = bearer({
        publicId: userPublicId,
        role: 'user',
        prj: projectId,
        scope: 'tools:ListTools',
      });
      expect(readRunTokenPrincipal(header)).toBeNull();
    });

    test('a plain user JWT is not inherited', () => {
      const header = bearer({ publicId: userPublicId, role: 'user' });
      expect(readRunTokenPrincipal(header)).toBeNull();
    });

    test('a missing, malformed or wrongly-signed header yields null', () => {
      expect(readRunTokenPrincipal(undefined)).toBeNull();
      expect(readRunTokenPrincipal('sk_notevenbearer')).toBeNull();
      expect(readRunTokenPrincipal('Bearer not.a.jwt')).toBeNull();
      expect(
        readRunTokenPrincipal(
          `Bearer ${jwt.sign({ publicId: userPublicId, prj: projectId, orn: 'orun_x' }, 'a-different-secret')}`
        )
      ).toBeNull();
    });

    test('a run token whose publicId claim is missing yields null', () => {
      const header = bearer({ role: 'user', prj: projectId, orn: 'orun_y' });
      expect(readRunTokenPrincipal(header)).toBeNull();
    });
  });

  /**
   * What a generation records as having started it (#894). The two exclusions
   * below are the security-relevant half and are the reason this is tested
   * directly: reaching the trigger and OAuth branches through an entry point
   * means standing up a trigger dispatch or a consented OAuth token *and* an
   * approval on the generation it produced, and the failure signal at the far
   * end — a continuation that quietly acts with too much access — would not
   * name which branch let it through.
   */
  describe('resolveStartingPrincipal', () => {
    test('names the acting user for a plain authenticated caller', () => {
      expect(
        resolveStartingPrincipal({ authUser: { publicId: userPublicId } })
      ).toEqual({ principalType: 'user', principalId: userPublicId });
    });

    test('names the key, not its owner, for a key-authenticated caller', () => {
      expect(
        resolveStartingPrincipal({
          authUser: { publicId: userPublicId, apiKeyPublicId: 'key_abc' },
        })
      ).toEqual({ principalType: 'api_key', principalId: 'key_abc' });
    });

    test('a run token names the same principal it was minted for', () => {
      // A run token is project-scoped, so it carries `oauthProjectPublicId`
      // like an OAuth token does — the `isRunToken` marker is what separates
      // the two, and getting that wrong would strand every nested chain.
      expect(
        resolveStartingPrincipal({
          authUser: {
            publicId: userPublicId,
            apiKeyPublicId: 'key_abc',
            oauthProjectPublicId: projectId,
            isRunToken: true,
          },
        })
      ).toEqual({ principalType: 'api_key', principalId: 'key_abc' });
    });

    test('a trigger-token caller records no principal', () => {
      // Its authority is the trigger's attached policy, which the principal
      // does not name; re-minting from it would widen the chain to everything
      // the owning user may do.
      expect(
        resolveStartingPrincipal({
          authUser: {
            publicId: userPublicId,
            oauthProjectPublicId: projectId,
            isTriggerToken: true,
          },
        })
      ).toBeNull();
    });

    test('an OAuth caller records no principal', () => {
      // Same reasoning, with the consented scope as the boundary.
      expect(
        resolveStartingPrincipal({
          authUser: {
            publicId: userPublicId,
            oauthProjectPublicId: projectId,
          },
        })
      ).toBeNull();
    });

    test('with no caller it falls back to the run token it was handed', () => {
      const authHeader = `Bearer ${signRunToken({
        publicId: userPublicId,
        role: 'user',
        projectPublicId: projectId,
        workPublicId: 'orun_start1',
      })}`;
      expect(resolveStartingPrincipal({ authHeader })).toEqual({
        principalType: 'user',
        principalId: userPublicId,
      });
    });

    test('with neither a caller nor a run token there is no principal', () => {
      expect(resolveStartingPrincipal({})).toBeNull();
      expect(
        resolveStartingPrincipal({
          authHeader: bearerTriggerToken(userPublicId, projectId),
        })
      ).toBeNull();
    });
  });
});

// A trigger run-as token, as an internal caller would forward it: it must not
// become a starting principal on the `authHeader` path either.
const bearerTriggerToken = (publicId: string, prj: string): string => {
  return `Bearer ${jwt.sign({ publicId, role: 'user', prj, trg: 'trg_abc' }, JWT_SECRET, { expiresIn: '5m' })}`;
};
