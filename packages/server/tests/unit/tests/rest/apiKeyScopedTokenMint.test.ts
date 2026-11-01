import jwt from 'jsonwebtoken';
import { signRunToken } from 'src/lib/orchestrationRunToken';
import { signTriggerToken } from 'src/lib/triggerToken';
import { JWT_SECRET } from 'src/middleware/auth';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A project-scoped token carries its boundary inline (consent scope, trigger
 * policy, starting key), and a minted key cannot carry it: it would hold the
 * owner's full permissions in the project. So such a token never writes a key.
 */
describe('API key writes from a project-scoped token', () => {
  let userToken: string;
  let userId: string;
  let projectId: string;
  let ownKeyId: string;
  let tokens: Array<[string, () => string]>;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'akscoped',
      policyActions: ['*'],
    });
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;

    const own = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({ name: 'Own Key', project_id: projectId });
    expect(own.status).toBe(201);
    ownKeyId = own.body.id;

    tokens = [
      [
        'OAuth',
        () => {
          return jwt.sign(
            {
              publicId: userId,
              role: 'user',
              scope: `* prj:${projectId}`,
              prj: projectId,
            },
            JWT_SECRET,
            { expiresIn: '1h' }
          );
        },
      ],
      [
        'trigger run-as',
        () => {
          return signTriggerToken({
            publicId: userId,
            role: 'user',
            projectPublicId: projectId,
            triggerId: 'trg_scopedmint',
          });
        },
      ],
      [
        'run',
        () => {
          return signRunToken({
            publicId: userId,
            role: 'user',
            projectPublicId: projectId,
            workPublicId: 'orn_scopedmint',
          });
        },
      ],
      [
        'key-started run',
        () => {
          return signRunToken({
            publicId: userId,
            role: 'user',
            projectPublicId: projectId,
            workPublicId: 'orn_scopedmint',
            apiKeyPublicId: ownKeyId,
          });
        },
      ],
    ];
  });

  const each = (
    name: string,
    fn: (token: string) => Promise<void>,
    kinds = ['OAuth', 'trigger run-as', 'run', 'key-started run']
  ) => {
    test.each(kinds)(`${name} (%s token)`, async (kind) => {
      const entry = tokens.find(([k]) => {
        return k === kind;
      });
      if (!entry) throw new Error(`no token for ${kind}`);
      await fn(entry[1]());
    });
  };

  describe('POST /api/v1/api-keys', () => {
    each('returns 403 API_KEY_SCOPED_TOKEN', async (token) => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/api-keys')
        .send({ name: 'Minted', project_id: projectId });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_SCOPED_TOKEN');
    });

    test('a user token still mints a key', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'User Minted', project_id: projectId });

      expect(res.status).toBe(201);
    });

    test('an API key still mints a key', async () => {
      const key = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Minter', project_id: projectId });

      const res = await authenticatedTestClient(key.body.key)
        .post('/api/v1/api-keys')
        .send({ name: 'Key Minted' });

      expect(res.status).toBe(201);
    });
  });

  describe('PUT /api/v1/api-keys/:api_key_id', () => {
    each('returns 403 API_KEY_SCOPED_TOKEN', async (token) => {
      const res = await authenticatedTestClient(token)
        .put(`/api/v1/api-keys/${ownKeyId}`)
        .send({ policy_ids: [] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_SCOPED_TOKEN');
    });

    test('a user token still updates a key', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/api-keys/${ownKeyId}`)
        .send({ name: 'Own Key Renamed' });

      expect(res.status).toBe(200);
    });
  });

  describe('an api_key formation resource', () => {
    each(
      'is refused with API_KEY_SCOPED_TOKEN',
      async (token) => {
        const res = await authenticatedTestClient(token)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `scoped-mint-${Math.random().toString(36).slice(2)}`,
            template: {
              resources: {
                Key: { type: 'api_key', properties: { name: 'Formation Key' } },
              },
            },
          });

        expect(res.body.status).not.toBe('active');
        expect(JSON.stringify(res.body)).toContain('API_KEY_SCOPED_TOKEN');
        // A trigger token's boundary needs a live trigger, which is beside the
        // point here: the refusal reads the credential kind, not its boundary.
      },
      ['OAuth', 'run', 'key-started run']
    );
  });
});
