import jwt from 'jsonwebtoken';
import { signFileDownloadToken } from 'src/lib/fileDownloadToken';
import { signIngestionCallbackToken } from 'src/lib/ingestionCallbackToken';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const mcpToolsList = (token: string) => {
  return testClient
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
};

describe('auth middleware', () => {
  describe('JWT_SECRET requirement', () => {
    test('module throws at load time when JWT_SECRET is unset', () => {
      const previousSecret = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;

      expect(() => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('src/lib/signedTokens');
        });
      }).toThrow('JWT_SECRET environment variable is not set');

      process.env.JWT_SECRET = previousSecret;
    });
  });

  describe('a token is accepted only by the verifiers of its kind', () => {
    let userPublicId: string;
    let loginToken: string;

    beforeAll(async () => {
      await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'tokenkinds', password: 'tokenkindspass' });
      loginToken = await loginAs('tokenkinds', 'tokenkindspass');
      const me =
        await authenticatedTestClient(loginToken).get('/api/v1/users/me');
      userPublicId = me.body.id;
    });

    const downloadToken = () => {
      return signFileDownloadToken({ fileId: 'fil_nonexistent' });
    };

    const callbackToken = () => {
      return signIngestionCallbackToken({
        documentId: 'doc_nonexistent',
        attemptId: 'att_x',
      });
    };

    test('a login token is accepted on REST and at the MCP gate', async () => {
      const rest =
        await authenticatedTestClient(loginToken).get('/api/v1/projects');
      expect(rest.status).toBe(200);
      expect((await mcpToolsList(loginToken)).status).toBe(200);
    });

    test('a file-download token is refused on REST with 401', async () => {
      const response =
        await authenticatedTestClient(downloadToken()).get('/api/v1/projects');
      expect(response.status).toBe(401);
    });

    test('a file-download token is refused at the MCP gate with 401', async () => {
      expect((await mcpToolsList(downloadToken())).status).toBe(401);
    });

    test('an ingestion-callback token is refused on REST with 401', async () => {
      const response =
        await authenticatedTestClient(callbackToken()).get('/api/v1/projects');
      expect(response.status).toBe(401);
    });

    test('an ingestion-callback token is refused at the MCP gate with 401', async () => {
      expect((await mcpToolsList(callbackToken())).status).toBe(401);
    });

    test('a token without a `typ` is refused on REST and at the MCP gate', async () => {
      const untyped = jwt.sign(
        { publicId: userPublicId, role: 'admin' },
        String(process.env.JWT_SECRET),
        { expiresIn: '5m' }
      );
      const rest =
        await authenticatedTestClient(untyped).get('/api/v1/projects');
      expect(rest.status).toBe(401);
      expect((await mcpToolsList(untyped)).status).toBe(401);
    });
  });
});
