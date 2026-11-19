import { resolveSoatTools } from 'src/lib/agentToolResolverExternalTools';
import type { WorkAuthority } from 'src/lib/workAuthority';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { ORPHAN_AUTHORITY } from '../../fixtures/workAuthority';
import {
  authenticatedTestClient,
  workAuthorityOfToken,
} from '../../testClient';

const DEFAULT_CALLBACK = 'https://front.example.com/oauth/callback';
const OWN_CALLBACK = 'https://app.example.com/cb';

const UNMETERED = {
  projectId: 0,
  toolId: null,
  workId: null,
  attribution: {},
  sender: { authority: ORPHAN_AUTHORITY },
};

/**
 * `OAUTH_DEFAULT_REDIRECT_URI` is the callback a client written without one
 * stores, alike over REST, a formation and a `builtin` action.
 */
describe('the deployment default redirect_uri', () => {
  let adminToken: string;
  let adminAuthority: WorkAuthority;
  let projectId: string;
  let seq = 0;

  const clientFields = (overrides: Record<string, unknown> = {}) => {
    return {
      name: 'x',
      authorize_url: 'https://x.com/i/oauth2/authorize',
      token_url: 'https://api.x.com/2/oauth2/token',
      client_id: 'x-client-id',
      scopes: ['tweet.read'],
      ...overrides,
    };
  };

  const createOverRest = async (overrides: Record<string, unknown> = {}) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/oauth-clients')
      .send({ project_id: projectId, ...clientFields(overrides) });
    expect(res.status).toBe(201);
    return res.body as { id: string; redirect_uri: string | null };
  };

  const createInFormation = async (overrides: Record<string, unknown> = {}) => {
    seq += 1;
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: `default-redirect-${seq}`,
        template: {
          resources: {
            XClient: {
              type: 'oauth_client',
              properties: clientFields(overrides),
            },
          },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    const clientId = (
      res.body.resources as { physical_resource_id: string }[]
    )[0].physical_resource_id;
    const read = await authenticatedTestClient(adminToken).get(
      `/api/v1/oauth-clients/${clientId}`
    );
    return read.body as { redirect_uri: string | null };
  };

  const createOverBuiltin = async (overrides: Record<string, unknown> = {}) => {
    const tools = resolveSoatTools({
      meter: UNMETERED,
      typedTool: {
        name: 'oauth',
        description: null,
        actions: ['create-oauth-client'],
        presetParameters: null,
      },
      authority: adminAuthority,
      projectPublicId: projectId,
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: () => {},
    });
    return (await tools['oauth_create-oauth-client'].execute?.(
      clientFields(overrides),
      { messages: [], toolCallId: 'call_1', context: undefined }
    )) as { redirect_uri: string | null };
  };

  const PATHS = [
    ['REST', createOverRest],
    ['a formation', createInFormation],
    ['a builtin action', createOverBuiltin],
  ] as const;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'oauthdefaultredirect',
      policyActions: ['oauth-clients:*', 'formations:*'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    adminAuthority = await workAuthorityOfToken({
      token: adminToken,
      project: null,
    });
  });

  afterEach(() => {
    delete process.env.OAUTH_DEFAULT_REDIRECT_URI;
  });

  describe('set', () => {
    beforeEach(() => {
      process.env.OAUTH_DEFAULT_REDIRECT_URI = DEFAULT_CALLBACK;
    });

    test.each(PATHS)(
      '%s stores it for an absent redirect_uri',
      async (_, create) => {
        expect((await create()).redirect_uri).toBe(DEFAULT_CALLBACK);
      }
    );

    test.each(PATHS)(
      '%s stores it for a null redirect_uri',
      async (_, create) => {
        expect((await create({ redirect_uri: null })).redirect_uri).toBe(
          DEFAULT_CALLBACK
        );
      }
    );

    test.each(PATHS)('%s keeps a sent redirect_uri', async (_, create) => {
      expect((await create({ redirect_uri: OWN_CALLBACK })).redirect_uri).toBe(
        OWN_CALLBACK
      );
    });

    test('an update setting redirect_uri null stores it', async () => {
      const { id } = await createOverRest({ redirect_uri: OWN_CALLBACK });
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/oauth-clients/${id}`)
        .send({ redirect_uri: null });
      expect(res.status).toBe(200);
      expect(res.body.redirect_uri).toBe(DEFAULT_CALLBACK);
    });

    test('an update not naming redirect_uri leaves it', async () => {
      const { id } = await createOverRest({ redirect_uri: OWN_CALLBACK });
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/oauth-clients/${id}`)
        .send({ name: 'renamed' });
      expect(res.status).toBe(200);
      expect(res.body.redirect_uri).toBe(OWN_CALLBACK);
    });
  });

  describe('unset', () => {
    test.each(PATHS)('%s stores null', async (_, create) => {
      expect((await create()).redirect_uri).toBeNull();
    });
  });
});
