import { soatTools } from 'src/lib/soatTools';

/**
 * Collects every path in `node` whose value is `undefined`.
 *
 * JSON has no `undefined`, so such a key is invisible to clients once the
 * schema is serialised — which is exactly what makes it dangerous. The value
 * survives on the in-memory object that gets handed to the JSON Schema
 * validator when an MCP tool is registered, and that validator throws while
 * compiling `properties`, taking the whole server down at startup.
 *
 * `dereferenceSchema` produces these for a `$ref` it cannot resolve: it follows
 * only same-file `#/components/schemas/...` refs, so a cross-file ref such as
 * `ToolBinding.properties.tool` → `./tools.yaml#/...` leaves `undefined` behind.
 */
const findUndefinedPaths = (
  node: unknown,
  path: string,
  found: string[]
): void => {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const [index, entry] of node.entries()) {
      if (entry === undefined) found.push(`${path}[${index}]`);
      findUndefinedPaths(entry, `${path}[${index}]`, found);
    }
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value === undefined) found.push(`${path}.${key}`);
    findUndefinedPaths(value, `${path}.${key}`, found);
  }
};

describe('generated tool schema integrity (real OpenAPI specs)', () => {
  test('derives a tool surface from the specs on disk', () => {
    expect(soatTools.length).toBeGreaterThan(0);
  });

  test('no generated inputSchema carries an undefined value', () => {
    const found: string[] = [];

    for (const tool of soatTools) {
      findUndefinedPaths(tool.inputSchema, tool.name, found);
    }

    expect(found).toEqual([]);
  });

  test('every inputSchema survives a JSON round-trip unchanged', () => {
    // A schema that changes shape when serialised is carrying something JSON
    // cannot express — the same failure mode as above, stated structurally.
    for (const tool of soatTools) {
      expect(JSON.parse(JSON.stringify(tool.inputSchema))).toEqual(
        tool.inputSchema
      );
    }
  });

  test('a cross-file $ref resolves to an empty schema, staying discoverable', () => {
    // This cross-file `$ref` cannot be followed, so resolving it to `{}` keeps
    // the field discoverable rather than hiding one the API does accept.
    const patchAgent = soatTools.find((tool) => {
      return tool.name === 'patch-agent';
    });
    const properties = patchAgent?.inputSchema.properties as Record<
      string,
      { items?: { properties?: Record<string, unknown> } }
    >;
    const bindingProperties = properties?.tool_bindings?.items?.properties;

    expect(bindingProperties).toHaveProperty('tool', {});
    expect(bindingProperties?.tool_id).toEqual(
      expect.objectContaining({ type: 'string' })
    );
  });
});
