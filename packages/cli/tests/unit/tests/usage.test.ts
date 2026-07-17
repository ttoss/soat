import { createCliTestClient } from '../testClient';

// CLI parity for the usage module: the `usage` REST/MCP surface exposes usage
// aggregation and spend thresholds, and the generated CLI manifest must expose
// them too (`get-usage`, `list-usage-thresholds`, `create-usage-threshold`,
// `delete-usage-threshold`). These tests lock that parity in so a spec/manifest
// regression can't silently drop the commands again.
describe('usage commands', () => {
  const cli = createCliTestClient();

  beforeEach(() => {
    cli.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('get-usage sends project_id, group_by and the time window as query params', async () => {
    const requests = await cli.call([
      'get-usage',
      '--project_id',
      'prj_test',
      '--group_by',
      'model',
      '--from',
      '2026-01-01T00:00:00.000Z',
      '--to',
      '2026-02-01T00:00:00.000Z',
    ]);

    expect(cli.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/usage');

    const url = new URL((cli.fetchMock.mock.calls[0]?.[0] as Request).url);
    expect(url.searchParams.get('project_id')).toBe('prj_test');
    expect(url.searchParams.get('group_by')).toBe('model');
    expect(url.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-02-01T00:00:00.000Z');
  });

  test('get-usage works with only the required project_id and group_by', async () => {
    const requests = await cli.call([
      'get-usage',
      '--project_id',
      'prj_test',
      '--group_by',
      'day',
    ]);

    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/usage');

    const url = new URL((cli.fetchMock.mock.calls[0]?.[0] as Request).url);
    expect(url.searchParams.get('group_by')).toBe('day');
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });

  test('list-usage-thresholds performs a GET filtered by project_id', async () => {
    const requests = await cli.call([
      'list-usage-thresholds',
      '--project_id',
      'prj_test',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/usage/thresholds');

    const url = new URL((cli.fetchMock.mock.calls[0]?.[0] as Request).url);
    expect(url.searchParams.get('project_id')).toBe('prj_test');
  });

  test('create-usage-threshold POSTs the threshold body with a numeric threshold', async () => {
    const requests = await cli.call([
      'create-usage-threshold',
      '--project_id',
      'prj_test',
      '--metric',
      'cost_usd',
      '--window',
      'calendar_month',
      '--threshold',
      '100',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/usage/thresholds');

    const body = requests[0]?.body as {
      project_id?: unknown;
      metric?: unknown;
      window?: unknown;
      threshold?: unknown;
    };
    expect(body).toEqual({
      project_id: 'prj_test',
      metric: 'cost_usd',
      window: 'calendar_month',
      threshold: 100,
    });
    // The number-typed flag must reach the wire as a JSON number, not a string.
    expect(typeof body.threshold).toBe('number');
  });

  test('delete-usage-threshold sends a DELETE to the threshold path param', async () => {
    const requests = await cli.call([
      'delete-usage-threshold',
      '--threshold_id',
      'uthr_test',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.path).toBe('/api/v1/usage/thresholds/uthr_test');
  });

  test('delete-usage-threshold accepts a bare positional id', async () => {
    const requests = await cli.call(['delete-usage-threshold', 'uthr_test']);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.path).toBe('/api/v1/usage/thresholds/uthr_test');
  });
});
