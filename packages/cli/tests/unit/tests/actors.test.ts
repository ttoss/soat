import { createCliTestClient } from '../testClient';

describe('actors commands', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('list-actors performs a normal GET call to actors endpoint', async () => {
    const requests = await cliTestClient.call([
      'list-actors',
      '--project-id',
      'proj_test',
      '--limit',
      '10',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/actors');

    const firstRequest = cliTestClient.fetchMock.mock.calls[0]?.[0] as Request;
    const url = new URL(firstRequest.url);

    expect(url.searchParams.get('project_id')).toBe('proj_test');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});
