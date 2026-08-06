import { createCliTestClient } from '../testClient';

// A flag the spec declares as `type: string` must reach the server as a string,
// whatever its content looks like. Value coercion used to be type-blind: any
// value starting with `{` or `[`, or matching a number/boolean/null, was parsed
// as JSON. That made a whole class of string payloads unsendable from the CLI —
// most visibly `create-secret --value "$(cat service-account.json)"`, where a
// GCP service account key file was sent as an object and the server answered
// 500 instead of storing the secret.
describe('string-typed flags are not JSON-coerced', () => {
  const cli = createCliTestClient();

  beforeEach(() => {
    cli.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('a JSON document passed to a string flag stays a string', async () => {
    const keyFile = '{"type":"service_account","project_id":"my-gcp-project"}';

    const requests = await cli.call([
      'create-secret',
      '--project_id',
      'proj_1',
      '--name',
      'gcp-service-account',
      '--value',
      keyFile,
    ]);

    const body = requests[0]?.body as { value?: unknown };
    expect(body.value).toBe(keyFile);
  });

  test('a numeric-looking string flag stays a string', async () => {
    const requests = await cli.call([
      'create-secret',
      '--project_id',
      'proj_1',
      '--name',
      'account-number',
      '--value',
      '4455',
    ]);

    const body = requests[0]?.body as { value?: unknown };
    expect(body.value).toBe('4455');
  });

  test('an object-typed flag is still parsed as JSON', async () => {
    const requests = await cli.call([
      'create-tool',
      '--project_id',
      'proj_1',
      '--name',
      'get-s3-object',
      '--type',
      'http',
      '--execute',
      '{"url":"https://example.com","method":"GET"}',
    ]);

    const body = requests[0]?.body as { execute?: unknown };
    expect(body.execute).toEqual({
      url: 'https://example.com',
      method: 'GET',
    });
  });

  test('an integer-typed flag is still parsed as a number', async () => {
    await cli.call(['list-actors', '--project_id', 'proj_1', '--limit', '10']);

    const url = new URL((cli.fetchMock.mock.calls[0]?.[0] as Request).url);
    expect(url.searchParams.get('limit')).toBe('10');
  });
});
