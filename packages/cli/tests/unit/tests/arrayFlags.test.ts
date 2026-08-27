import { createCliTestClient } from '../testClient';

// Array-typed body flags must serialize as JSON arrays. The dispatcher used to
// send only the last scalar per flag, so the server received a string, ran
// `paths.map(...)` on it and answered 500 — the "matches nothing" bug.
describe('array-typed body flags are sent as arrays', () => {
  const cli = createCliTestClient();

  beforeEach(() => {
    cli.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('a single --document_paths value is sent as a one-element array', async () => {
    const requests = await cli.call([
      'search-knowledge',
      '--project_id',
      'proj_1',
      '--document_paths',
      '/playbooks/',
    ]);

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as { document_paths?: unknown };
    expect(body.document_paths).toEqual(['/playbooks/']);
  });

  test('repeated --document_paths flags collect into an array', async () => {
    const requests = await cli.call([
      'search-knowledge',
      '--document_paths',
      '/a/',
      '--document_paths',
      '/b/',
    ]);

    const body = requests[0]?.body as { document_paths?: unknown };
    expect(body.document_paths).toEqual(['/a/', '/b/']);
  });

  test('a JSON array literal is still accepted for an array flag', async () => {
    const requests = await cli.call([
      'search-knowledge',
      '--document_ids',
      '["doc_1","doc_2"]',
    ]);

    const body = requests[0]?.body as { document_ids?: unknown };
    expect(body.document_ids).toEqual(['doc_1', 'doc_2']);
  });

  test('a scalar body flag is unchanged (string, not wrapped)', async () => {
    const requests = await cli.call([
      'search-knowledge',
      '--query',
      'deep diagnosis contract',
    ]);

    const body = requests[0]?.body as { query?: unknown };
    expect(body.query).toBe('deep diagnosis contract');
  });
});
