import { createCliTestClient } from '../testClient';

// Undeclared as query parameters, these fell through the dispatcher's split
// into the request body — and fetch rejects a GET carrying one, making
// pagination impossible from the CLI.
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
