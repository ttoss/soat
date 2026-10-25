import { routes } from '../../../src/generated/routes';

/**
 * A body that says "exactly one of" with a `oneOf` of `required`-only branches
 * still declares its fields in `properties`; the generator must give each its
 * own flag rather than collapse the body into one `--body` object.
 */
describe('a body with a presence-only union keeps a flag per field', () => {
  test('create-ingestion-rule takes --tool-id and --agent-id', () => {
    const flags = routes['create-ingestion-rule'].flags.map((flag) => {
      return `${flag.name}:${flag.in}`;
    });

    expect(flags).toEqual(
      expect.arrayContaining([
        'content_type_glob:body',
        'tool_id:body',
        'agent_id:body',
      ])
    );
    expect(flags).not.toContain('body:body-root');
  });

  test('content_type_glob stays required, tool_id and agent_id optional', () => {
    const required = routes['create-ingestion-rule'].flags
      .filter((flag) => {
        return flag.required;
      })
      .map((flag) => {
        return flag.name;
      });

    expect(required).toEqual(['content_type_glob']);
  });
});
