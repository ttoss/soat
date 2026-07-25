import { createCliTestClient } from '../testClient';

describe('audit-log commands', () => {
  const cliTestClient = createCliTestClient();
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    cliTestClient.reset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('export-audit-entries GETs the export path with its filters', async () => {
    const requests = await cliTestClient.call([
      'export-audit-entries',
      '--project-id',
      'proj_test',
      '--action',
      'secrets:DeleteSecret',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/api/v1/audit-log/export');
    expect(requests[0]?.query.project_id).toBe('proj_test');
    expect(requests[0]?.query.action).toBe('secrets:DeleteSecret');
  });

  test('an NDJSON body is printed as raw lines, not JSON-stringified', async () => {
    const ndjson =
      '{"id":"audit_1","action":"secrets:CreateSecret"}\n' +
      '{"id":"audit_2","action":"secrets:DeleteSecret"}\n';

    cliTestClient.setResponse({
      body: ndjson,
      contentType: 'application/x-ndjson',
    });

    await cliTestClient.call([
      'export-audit-entries',
      '--project-id',
      'proj_test',
    ]);

    const printed = String(logSpy.mock.calls.at(-1)?.[0]);
    // Each line must survive as parseable JSON — the whole point of NDJSON.
    const lines = printed.split('\n').filter((line) => {
      return line.trim().length > 0;
    });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('audit_1');
    expect(JSON.parse(lines[1]).action).toBe('secrets:DeleteSecret');
  });

  test('a JSON body is still pretty-printed as an object', async () => {
    cliTestClient.setResponse({
      body: '{"total":2,"data":[]}',
      contentType: 'application/json',
    });

    await cliTestClient.call([
      'list-audit-entries',
      '--project-id',
      'proj_test',
    ]);

    const printed = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(printed).total).toBe(2);
    expect(printed).toContain('\n  ');
  });
});
