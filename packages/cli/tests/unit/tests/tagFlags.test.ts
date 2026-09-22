import { routes } from '../../../src/generated/routes';

/**
 * The tag bag is declared once, in `tags.yaml`, and every tagged resource
 * `$ref`s it across files.
 *
 * Both failure modes this guards against are silent — the manifest generates
 * either way. A query parameter the generator cannot resolve is dropped from
 * the manifest entirely (`--tags` becomes an unknown flag), and a body
 * property it cannot resolve falls back to `type: string`, so
 * `--tags '{"team":"finance"}'` reaches the server as literal text rather than
 * an object.
 */
const flagOf = (command: string, name: string) => {
  const route = routes[command as keyof typeof routes];
  expect(route).toBeDefined();
  return route.flags.find((flag) => {
    return flag.name === name;
  });
};

describe('tag flags survive the shared spec components', () => {
  test.each([
    'list-actors',
    'list-conversations',
    'list-documents',
    'list-files',
    'list-memory-stores',
    'list-memories',
    'list-sessions',
  ])('%s declares --tags as a repeatable query flag', (command) => {
    const flag = flagOf(command, 'tags');

    expect(flag).toMatchObject({ type: 'array', in: 'query' });
  });

  test.each([
    'create-document',
    'ingest-document',
    'update-document',
    'update-actor',
    'create-memory-store',
    'update-memory-store',
    'create-memory',
    'update-memory',
    'fork-session',
  ])('%s declares --tags as an object body flag', (command) => {
    const flag = flagOf(command, 'tags');

    expect(flag).toMatchObject({ type: 'object', in: 'body' });
  });

  test('the shared description reaches the flag, so --help explains the bag', () => {
    const flag = flagOf('create-document', 'tags');

    expect(flag?.description).toContain('Key-value labels on a resource');
  });
});
