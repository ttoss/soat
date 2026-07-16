import { createCliTestClient } from '../testClient';

// `--limit`/`--offset` on `list-documents` were falling through the generic
// dispatcher's path/query/body split into the request body, because the
// OpenAPI spec did not declare them as query parameters. A GET request with
// a body is rejected by the fetch runtime ("Request with GET/HEAD method
// cannot have body."), making pagination impossible via the CLI.
describe('list-documents pagination flags are sent as query params', () => {
  const cli = createCliTestClient();

  beforeEach(() => {
    cli.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('--limit and --offset are serialized as query params, not body', async () => {
    const requests = await cli.call([
      'list-documents',
      '--project_id',
      'proj_1',
      '--limit',
      '50',
      '--offset',
      '0',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.query).toMatchObject({
      project_id: 'proj_1',
      limit: '50',
      offset: '0',
    });
    expect(requests[0]?.body).toBeUndefined();
  });
});
