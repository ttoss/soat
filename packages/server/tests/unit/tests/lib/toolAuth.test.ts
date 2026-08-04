import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { DomainError } from '../../../../src/errors';
import {
  applyHttpToolAuth,
  mergeAuthHeaders,
  parseHttpToolAuthConfig,
  signAwsSigV4,
  validateHttpToolAuth,
} from '../../../../src/lib/toolAuth';

/**
 * `toolAuth` qualifies for a direct `lib/` test under the keep-list rule: SigV4
 * is a pure algorithm whose input space (canonicalization of path, query,
 * headers, payload) is far larger than what driving one `POST /tools/:id/call`
 * per case could resolve — a wrong signature surfaces over REST only as an
 * opaque upstream 403 that names no branch.
 */

// The canonical AWS Signature Version 4 worked example from the AWS docs
// ("Signature Version 4 signing process" — ListUsers against IAM). Its
// intermediate values are published, so a mismatch localizes the defect:
// a wrong canonical-request hash is canonicalization, a wrong signature with
// the right hash is key derivation.
const AWS_EXAMPLE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'iam',
  url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
  method: 'GET',
  contentType: 'application/x-www-form-urlencoded; charset=utf-8',
  date: new Date('2015-08-30T12:36:00Z'),
  expectedCanonicalRequestHash:
    'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
  expectedSignature:
    '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
};

const sha256Hex = (value: string): string => {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
};

const EMPTY_PAYLOAD_HASH = sha256Hex('');

describe('toolAuth', () => {
  describe('signAwsSigV4', () => {
    test('reproduces the published AWS worked example end to end', () => {
      const result = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: AWS_EXAMPLE.region,
          service: AWS_EXAMPLE.service,
          accessKeyId: AWS_EXAMPLE.accessKeyId,
          secretAccessKey: AWS_EXAMPLE.secretAccessKey,
        },
        method: AWS_EXAMPLE.method,
        url: AWS_EXAMPLE.url,
        headers: { 'Content-Type': AWS_EXAMPLE.contentType },
        now: AWS_EXAMPLE.date,
      });

      expect(result.canonicalRequestHash).toBe(
        AWS_EXAMPLE.expectedCanonicalRequestHash
      );
      expect(result.headers['Authorization']).toBe(
        `AWS4-HMAC-SHA256 Credential=${AWS_EXAMPLE.accessKeyId}/20150830/${AWS_EXAMPLE.region}/${AWS_EXAMPLE.service}/aws4_request, ` +
          'SignedHeaders=content-type;host;x-amz-date, ' +
          `Signature=${AWS_EXAMPLE.expectedSignature}`
      );
      expect(result.headers['X-Amz-Date']).toBe('20150830T123600Z');
    });

    test('hashes a JSON body into the payload hash instead of the empty hash', () => {
      const body = JSON.stringify({ Bucket: 'my-bucket' });

      const withBody = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'lambda',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'POST',
        url: 'https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/f/invocations',
        headers: { 'Content-Type': 'application/json' },
        body,
        now: AWS_EXAMPLE.date,
      });

      expect(withBody.payloadHash).toBe(sha256Hex(body));
      expect(withBody.payloadHash).not.toBe(EMPTY_PAYLOAD_HASH);
    });

    test('sorts and RFC3986-encodes the canonical query string', () => {
      // Deliberately unsorted keys and a value needing encoding: a signature
      // that ignored either would still be well-formed but rejected by AWS.
      const unsorted = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'execute-api',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'GET',
        url: 'https://api.example.com/path?b=2&a=hello+world&c=a%2Fb',
        now: AWS_EXAMPLE.date,
      });

      const sorted = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'execute-api',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'GET',
        url: 'https://api.example.com/path?a=hello+world&c=a%2Fb&b=2',
        now: AWS_EXAMPLE.date,
      });

      expect(unsorted.canonicalRequest).toContain(
        'a=hello%20world&b=2&c=a%2Fb'
      );
      // Query order on the wire must not change the signature.
      expect(unsorted.headers['Authorization']).toBe(
        sorted.headers['Authorization']
      );
    });

    test('signs and forwards a session token for temporary credentials', () => {
      const result = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'sts',
          accessKeyId: 'ASIAEXAMPLE',
          secretAccessKey: 'secret',
          sessionToken: 'FwoGZXIvYXdzEExampleToken',
        },
        method: 'GET',
        url: 'https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
        now: AWS_EXAMPLE.date,
      });

      expect(result.headers['X-Amz-Security-Token']).toBe(
        'FwoGZXIvYXdzEExampleToken'
      );
      expect(result.headers['Authorization']).toContain(
        'SignedHeaders=host;x-amz-date;x-amz-security-token'
      );
    });

    test('sends the payload hash header for s3 and single-encodes its path', () => {
      const result = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 's3',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'GET',
        url: 'https://my-bucket.s3.us-east-1.amazonaws.com/folder/a%20b.txt',
        now: AWS_EXAMPLE.date,
      });

      expect(result.headers['X-Amz-Content-Sha256']).toBe(EMPTY_PAYLOAD_HASH);
      // S3 encodes path segments once; a non-S3 service would double-encode
      // the %20 into %2520.
      expect(result.canonicalRequest).toContain('/folder/a%20b.txt');
    });

    test('escapes the RFC3986 characters encodeURIComponent leaves alone', () => {
      // `encodeURIComponent` passes !'()* through, but SigV4's canonical form
      // requires them percent-encoded — an unescaped one changes the signature
      // AWS computes and the request is rejected.
      const result = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'execute-api',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'GET',
        url: "https://api.example.com/?filter=(a)!*'",
        now: AWS_EXAMPLE.date,
      });

      expect(result.canonicalRequest).toContain('filter=%28a%29%21%2A%27');
    });

    test('breaks ties between duplicate query keys by value', () => {
      const result = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'execute-api',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'GET',
        url: 'https://api.example.com/?id=2&id=1&id=2',
        now: AWS_EXAMPLE.date,
      });

      // Same key repeated: SigV4 orders the duplicates by their encoded value.
      expect(result.canonicalRequest).toContain('id=1&id=2&id=2');
    });

    test('double-encodes path segments for non-s3 services', () => {
      const result = signAwsSigV4({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 'execute-api',
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'secret',
        },
        method: 'GET',
        url: 'https://api.example.com/a%20b',
        now: AWS_EXAMPLE.date,
      });

      expect(result.canonicalRequest).toContain('/a%2520b');
    });
  });

  describe('parseHttpToolAuthConfig', () => {
    test('reads snake_case wire keys into camelCase internals', () => {
      const parsed = parseHttpToolAuthConfig({
        type: 'aws_sigv4',
        region: 'sa-east-1',
        service: 's3',
        access_key_id: 'AKIA1',
        secret_access_key: 'shh',
        session_token: 'tok',
      });

      expect(parsed).toEqual({
        type: 'aws_sigv4',
        region: 'sa-east-1',
        service: 's3',
        accessKeyId: 'AKIA1',
        secretAccessKey: 'shh',
        sessionToken: 'tok',
      });
    });

    test('reads a gcp service account config', () => {
      const parsed = parseHttpToolAuthConfig({
        type: 'gcp_service_account',
        credentials: '{"client_email":"a@b.iam.gserviceaccount.com"}',
        scopes: ['https://www.googleapis.com/auth/bigquery'],
      });

      expect(parsed).toEqual({
        type: 'gcp_service_account',
        credentials: '{"client_email":"a@b.iam.gserviceaccount.com"}',
        scopes: ['https://www.googleapis.com/auth/bigquery'],
      });
    });

    test('returns undefined when no auth is configured', () => {
      expect(parseHttpToolAuthConfig(undefined)).toBeUndefined();
      expect(parseHttpToolAuthConfig(null)).toBeUndefined();
    });
  });

  describe('validateHttpToolAuth', () => {
    const expectRejected = (args: {
      auth: unknown;
      bodyMode?: 'json' | 'multipart';
      message: string;
    }) => {
      let caught: unknown;
      try {
        validateHttpToolAuth({ auth: args.auth, bodyMode: args.bodyMode });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('VALIDATION_FAILED');
      expect((caught as DomainError).message).toContain(args.message);
    };

    test('accepts a well-formed aws_sigv4 config', () => {
      expect(() => {
        validateHttpToolAuth({
          auth: {
            type: 'aws_sigv4',
            region: 'us-east-1',
            service: 's3',
            access_key_id: 'AKIA1',
            secret_access_key: '{{secret:sec_01}}',
          },
        });
      }).not.toThrow();
    });

    test('accepts a well-formed gcp_service_account config', () => {
      expect(() => {
        validateHttpToolAuth({
          auth: {
            type: 'gcp_service_account',
            credentials: '{{secret:sec_01}}',
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
        });
      }).not.toThrow();
    });

    test('rejects an unknown auth type naming the supported ones', () => {
      expectRejected({
        auth: { type: 'azure_ad' },
        message: "Unsupported execute.auth type 'azure_ad'",
      });
    });

    test('rejects aws_sigv4 missing region or service', () => {
      expectRejected({
        auth: {
          type: 'aws_sigv4',
          service: 's3',
          access_key_id: 'A',
          secret_access_key: 'B',
        },
        message: 'execute.auth.region is required',
      });
      expectRejected({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          access_key_id: 'A',
          secret_access_key: 'B',
        },
        message: 'execute.auth.service is required',
      });
    });

    test('rejects aws_sigv4 missing credentials', () => {
      expectRejected({
        auth: { type: 'aws_sigv4', region: 'us-east-1', service: 's3' },
        message: 'execute.auth.access_key_id is required',
      });
    });

    test('rejects gcp_service_account missing credentials or scopes', () => {
      expectRejected({
        auth: { type: 'gcp_service_account', scopes: ['x'] },
        message: 'execute.auth.credentials is required',
      });
      expectRejected({
        auth: { type: 'gcp_service_account', credentials: 'x' },
        message: 'execute.auth.scopes is required',
      });
    });

    test('rejects aws_sigv4 combined with multipart, which cannot be signed', () => {
      expectRejected({
        auth: {
          type: 'aws_sigv4',
          region: 'us-east-1',
          service: 's3',
          access_key_id: 'A',
          secret_access_key: 'B',
        },
        bodyMode: 'multipart',
        message: 'aws_sigv4 does not support body_mode "multipart"',
      });
    });

    test('rejects a non-object auth value', () => {
      expectRejected({
        auth: 'aws_sigv4',
        message: 'execute.auth must be an object',
      });
    });
  });

  describe('applyHttpToolAuth with gcp_service_account', () => {
    let tokenServer: http.Server;
    let tokenUri: string;
    let assertions: string[] = [];
    let tokenResponse: { status: number; body: unknown } = {
      status: 200,
      body: { access_token: 'ya29.first', expires_in: 3600 },
    };
    let publicKey: string;
    let privateKey: string;

    const credentialsFor = (clientEmail: string): string => {
      return JSON.stringify({
        type: 'service_account',
        client_email: clientEmail,
        private_key: privateKey,
        token_uri: tokenUri,
      });
    };

    beforeAll(async () => {
      const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      privateKey = pair.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      publicKey = pair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();

      tokenServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const assertion = params.get('assertion');
          if (assertion) assertions.push(assertion);
          res.statusCode = tokenResponse.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(tokenResponse.body));
        });
      });
      await new Promise<void>((resolve) => {
        tokenServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = tokenServer.address() as AddressInfo;
      tokenUri = `http://127.0.0.1:${port}/token`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        tokenServer.close(() => {
          resolve();
        });
      });
    });

    beforeEach(() => {
      assertions = [];
      tokenResponse = {
        status: 200,
        body: { access_token: 'ya29.first', expires_in: 3600 },
      };
    });

    test('mints a bearer token from a correctly signed JWT assertion', async () => {
      const headers = await applyHttpToolAuth({
        auth: {
          type: 'gcp_service_account',
          credentials: credentialsFor('mint@p.iam.gserviceaccount.com'),
          scopes: [
            'https://www.googleapis.com/auth/bigquery',
            'https://www.googleapis.com/auth/devstorage.read_only',
          ],
        },
        method: 'POST',
        url: 'https://bigquery.googleapis.com/bigquery/v2/projects/p/jobs',
        headers: {},
        now: AWS_EXAMPLE.date,
      });

      expect(headers['Authorization']).toBe('Bearer ya29.first');
      expect(assertions).toHaveLength(1);

      const [rawHeader, rawClaims, rawSignature] = assertions[0].split('.');
      expect(
        JSON.parse(Buffer.from(rawHeader, 'base64url').toString())
      ).toEqual({
        alg: 'RS256',
        typ: 'JWT',
      });
      expect(
        JSON.parse(Buffer.from(rawClaims, 'base64url').toString())
      ).toEqual({
        iss: 'mint@p.iam.gserviceaccount.com',
        scope:
          'https://www.googleapis.com/auth/bigquery https://www.googleapis.com/auth/devstorage.read_only',
        aud: tokenUri,
        iat: Math.floor(AWS_EXAMPLE.date.getTime() / 1000),
        exp: Math.floor(AWS_EXAMPLE.date.getTime() / 1000) + 3600,
      });

      // The signature must verify against the service account's public key —
      // a malformed signing step would still produce a parseable JWT.
      const verified = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${rawHeader}.${rawClaims}`),
        publicKey,
        Buffer.from(rawSignature, 'base64url')
      );
      expect(verified).toBe(true);
    });

    test('reuses a cached token within its lifetime and re-mints after it expires', async () => {
      const auth = {
        type: 'gcp_service_account' as const,
        credentials: credentialsFor('cache@p.iam.gserviceaccount.com'),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      };
      const request = {
        method: 'GET',
        url: 'https://compute.googleapis.com/compute/v1/projects/p/zones',
        headers: {},
      };

      const first = await applyHttpToolAuth({
        ...request,
        auth,
        now: new Date('2026-01-01T00:00:00Z'),
      });
      const cached = await applyHttpToolAuth({
        ...request,
        auth,
        // Well inside the 3600s lifetime.
        now: new Date('2026-01-01T00:10:00Z'),
      });

      expect(first['Authorization']).toBe('Bearer ya29.first');
      expect(cached['Authorization']).toBe('Bearer ya29.first');
      expect(assertions).toHaveLength(1);

      tokenResponse = {
        status: 200,
        body: { access_token: 'ya29.second', expires_in: 3600 },
      };

      const refreshed = await applyHttpToolAuth({
        ...request,
        auth,
        // Past the lifetime, so the cache entry is stale.
        now: new Date('2026-01-01T01:05:00Z'),
      });

      expect(refreshed['Authorization']).toBe('Bearer ya29.second');
      expect(assertions).toHaveLength(2);
    });

    test('surfaces a rejected token exchange as TOOL_AUTH_FAILED', async () => {
      tokenResponse = {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Invalid JWT' },
      };

      let caught: unknown;
      try {
        await applyHttpToolAuth({
          auth: {
            type: 'gcp_service_account',
            credentials: credentialsFor('bad@p.iam.gserviceaccount.com'),
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
          method: 'GET',
          url: 'https://compute.googleapis.com/x',
          headers: {},
          now: AWS_EXAMPLE.date,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('TOOL_AUTH_FAILED');
      expect((caught as DomainError).meta?.upstream_status).toBe(400);
    });

    // Each credential/response defect gets its own TOOL_AUTH_FAILED message,
    // because "the credential could not be produced" is useless on its own —
    // the operator needs to know which part to fix.
    const expectAuthFailure = async (args: {
      credentials: string;
      message: string;
    }) => {
      let caught: unknown;
      try {
        await applyHttpToolAuth({
          auth: {
            type: 'gcp_service_account',
            credentials: args.credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
          method: 'GET',
          url: 'https://compute.googleapis.com/x',
          headers: {},
          now: AWS_EXAMPLE.date,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('TOOL_AUTH_FAILED');
      expect((caught as DomainError).message).toContain(args.message);
    };

    test('rejects credentials that are not JSON at all', async () => {
      await expectAuthFailure({
        credentials: 'not-json',
        message: 'not valid service account JSON',
      });
    });

    test('rejects credentials that are valid JSON but not an object', async () => {
      await expectAuthFailure({
        credentials: '["not","an","object"]',
        message: 'must be a service account JSON object',
      });
    });

    test('rejects credentials missing client_email or private_key', async () => {
      await expectAuthFailure({
        credentials: JSON.stringify({
          client_email: 'only@p.iam.gserviceaccount.com',
        }),
        message: 'missing client_email or private_key',
      });
    });

    test('rejects a private key that cannot sign', async () => {
      await expectAuthFailure({
        credentials: JSON.stringify({
          client_email: 'badkey@p.iam.gserviceaccount.com',
          private_key:
            '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n',
          token_uri: tokenUri,
        }),
        message: 'Failed to sign the service account assertion',
      });
    });

    test('rejects a non-JSON body from the token endpoint', async () => {
      // The shared stub always JSON-stringifies its body, so a 200 with a
      // genuinely non-JSON payload needs its own one-off server.
      const rawServer = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain');
          res.end('<html>not json</html>');
        });
      });
      await new Promise<void>((resolve) => {
        rawServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = rawServer.address() as AddressInfo;

      try {
        let caught: unknown;
        try {
          await applyHttpToolAuth({
            auth: {
              type: 'gcp_service_account',
              credentials: JSON.stringify({
                client_email: 'rawbody@p.iam.gserviceaccount.com',
                private_key: privateKey,
                token_uri: `http://127.0.0.1:${port}/token`,
              }),
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            },
            method: 'GET',
            url: 'https://compute.googleapis.com/x',
            headers: {},
            now: AWS_EXAMPLE.date,
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(DomainError);
        expect((caught as DomainError).code).toBe('TOOL_AUTH_FAILED');
        expect((caught as DomainError).message).toContain('non-JSON response');
      } finally {
        await new Promise<void>((resolve) => {
          rawServer.close(() => {
            resolve();
          });
        });
      }
    });

    test('rejects a token response with no access_token', async () => {
      tokenResponse = { status: 200, body: { token_type: 'Bearer' } };

      await expectAuthFailure({
        credentials: JSON.stringify({
          client_email: 'notoken@p.iam.gserviceaccount.com',
          private_key: privateKey,
          token_uri: tokenUri,
        }),
        message: 'contained no access_token',
      });
    });

    test('falls back to the default lifetime when expires_in is absent', async () => {
      tokenResponse = {
        status: 200,
        body: { access_token: 'ya29.nolifetime' },
      };
      const auth = {
        type: 'gcp_service_account' as const,
        credentials: credentialsFor('nolifetime@p.iam.gserviceaccount.com'),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      };
      const request = {
        method: 'GET',
        url: 'https://compute.googleapis.com/x',
        headers: {},
      };

      const first = await applyHttpToolAuth({
        auth,
        ...request,
        now: new Date('2026-02-01T00:00:00Z'),
      });
      const cached = await applyHttpToolAuth({
        auth,
        ...request,
        now: new Date('2026-02-01T00:30:00Z'),
      });

      expect(first['Authorization']).toBe('Bearer ya29.nolifetime');
      // Cached under the 3600s default, so no second mint.
      expect(cached['Authorization']).toBe('Bearer ya29.nolifetime');
      expect(assertions).toHaveLength(1);
    });
  });

  describe('mergeAuthHeaders', () => {
    test('drops an existing header that collides only by case', () => {
      // Both keys survive an object spread and `Headers` would join their values
      // with a comma — sending something other than what was signed.
      const merged = mergeAuthHeaders({
        headers: {
          authorization: 'Bearer stale',
          'x-amz-date': '19700101T000000Z',
          'X-Trace': 'keep-me',
        },
        authHeaders: {
          Authorization: 'AWS4-HMAC-SHA256 Credential=…',
          'X-Amz-Date': '20150830T123600Z',
        },
      });

      expect(merged).toEqual({
        'X-Trace': 'keep-me',
        Authorization: 'AWS4-HMAC-SHA256 Credential=…',
        'X-Amz-Date': '20150830T123600Z',
      });
      expect(merged.authorization).toBeUndefined();
      expect(merged['x-amz-date']).toBeUndefined();
    });
  });

  describe('applyHttpToolAuth with aws_sigv4', () => {
    test('returns the signed headers for merging into the request', async () => {
      const headers = await applyHttpToolAuth({
        auth: {
          type: 'aws_sigv4',
          region: AWS_EXAMPLE.region,
          service: AWS_EXAMPLE.service,
          accessKeyId: AWS_EXAMPLE.accessKeyId,
          secretAccessKey: AWS_EXAMPLE.secretAccessKey,
        },
        method: AWS_EXAMPLE.method,
        url: AWS_EXAMPLE.url,
        headers: { 'Content-Type': AWS_EXAMPLE.contentType },
        now: AWS_EXAMPLE.date,
      });

      expect(headers['Authorization']).toContain(
        `Signature=${AWS_EXAMPLE.expectedSignature}`
      );
    });
  });
});
