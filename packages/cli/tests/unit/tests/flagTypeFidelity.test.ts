import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { routes } from '../../../src/generated/routes';

const SPECS_DIR = path.resolve(
  __dirname,
  '../../../../server/src/rest/openapi/v1'
);

/**
 * The manifest is derived from the specs, and a derivation can lose what it
 * cannot resolve. `string` is where that loss lands: it is the one type
 * `parseFlagValue` never JSON-coerces, so a flag degraded to it sends its value
 * as text and the endpoint refuses a body it should have taken. Nothing fails
 * at generation time, and the manifest reads the same either way — a `string`
 * that the spec declared and a `string` the generator guessed are one word.
 *
 * So the rule is one-way: a body flag may be typed `string` only where the
 * schema it traces to says `type: string`. A `$ref` is followed, because a ref
 * to a string enum is a string and refusing it would be a false alarm; a
 * `oneOf`/`anyOf` is a string only if every member is one, and a schema with no
 * type at all is not, which is the case OpenAPI 3.0 leaves a union in.
 */
describe('manifest flag types are the specs’ own', () => {
  type Schema = Record<string, unknown>;

  /** A spec's own `components.schemas`, for resolving its local `$ref`s. */
  const componentsOf = (file: string): Record<string, Schema> => {
    const spec = yaml.load(
      fs.readFileSync(path.join(SPECS_DIR, file), 'utf8')
    ) as {
      components?: { schemas?: Record<string, Schema> };
    };
    return spec.components?.schemas ?? {};
  };

  /**
   * Whether a schema is a string, following one `$ref` hop and every member of
   * a union. A `$ref` out to another file is read from that file.
   */
  const isString = (schema: Schema | undefined, file: string): boolean => {
    if (!schema) return false;

    const ref = schema.$ref;
    if (typeof ref === 'string') {
      const [refFile, pointer] = ref.split('#');
      const name = pointer?.split('/').pop();
      if (!name) return false;
      const target = componentsOf(refFile ? path.basename(refFile) : file)[
        name
      ];
      return isString(target, refFile ? path.basename(refFile) : file);
    }

    const members = schema.oneOf ?? schema.anyOf ?? schema.allOf;
    if (Array.isArray(members)) {
      return members.every((member) => {
        return isString(member as Schema, file);
      });
    }

    return schema.type === 'string';
  };

  /** The body properties each operation declares, with its spec file. */
  const declaredBodyProperties = (): Map<
    string,
    { properties: Record<string, Schema>; file: string }
  > => {
    const byOperation = new Map<
      string,
      { properties: Record<string, Schema>; file: string }
    >();

    for (const file of fs.readdirSync(SPECS_DIR)) {
      if (!/\.ya?ml$/.test(file)) continue;

      const spec = yaml.load(
        fs.readFileSync(path.join(SPECS_DIR, file), 'utf8')
      ) as {
        paths?: Record<string, Record<string, Record<string, unknown>>>;
      };

      for (const pathItem of Object.values(spec.paths ?? {})) {
        for (const operation of Object.values(pathItem ?? {})) {
          const operationId = operation?.operationId as string | undefined;
          const properties = (
            operation?.requestBody as
              | {
                  content?: Record<
                    string,
                    {
                      schema?: {
                        properties?: Record<string, Record<string, unknown>>;
                      };
                    }
                  >;
                }
              | undefined
          )?.content?.['application/json']?.schema?.properties;

          if (operationId && properties) {
            byOperation.set(operationId, { properties, file });
          }
        }
      }
    }

    return byOperation;
  };

  test('a `string` body flag is one the spec calls a string', () => {
    const declared = declaredBodyProperties();
    const guessed: string[] = [];

    for (const [command, route] of Object.entries(routes)) {
      const entry = declared.get(route.operationId);
      if (!entry) continue;

      for (const flag of route.flags) {
        if (flag.in !== 'body' || flag.type !== 'string') continue;

        const property = entry.properties[flag.name];
        if (!property || isString(property, entry.file)) continue;

        const shape = property.$ref
          ? `$ref ${String(property.$ref)}`
          : Object.keys(property).join(', ');
        guessed.push(`${command} --${flag.name} (spec declares ${shape})`);
      }
    }

    expect(guessed.sort()).toEqual([]);
  });

  test('the manifest carries body flags at all', () => {
    // Guards the assertion above from passing because nothing was inspected.
    const bodyFlags = Object.values(routes).flatMap((route) => {
      return route.flags.filter((flag) => {
        return flag.in === 'body';
      });
    });

    expect(bodyFlags.length).toBeGreaterThan(100);
  });
});
