import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isObjectRecord } from 'src/lib/openapiSchemaFields';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

/**
 * One shape for every list filter, so a caller who learned it on one route
 * never meets a second spelling on the next:
 *
 * - A `status` or `*_status` filter repeats, values ORed: an array of the enum,
 *   `style: form`, `explode: true`, read through `parseEnumListQuery`.
 * - A time range is `from`/`to` (or `<field>_from`/`<field>_to` for a
 *   timestamp other than the record's natural one), never `since`, `until`,
 *   `*_before` or `*_after`.
 *
 * The spec half covers the SDK, CLI and MCP surface generated from it; the
 * source half keeps a handler from reading a status filter as one string while
 * its spec says it repeats.
 */

const ROUTES_DIR = join(__dirname, '../../../../src/rest/v1');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const STATUS_NAME = /^(\w+_)?status$/;

const TIME_RANGE_NAME = /^(since|until|\w+_before|\w+_after)$/;

type QueryParameter = {
  label: string;
  parameter: Record<string, unknown>;
};

const resolveParameter = (
  parameter: unknown
): Record<string, unknown> | null => {
  if (!isObjectRecord(parameter)) return null;
  const ref = parameter.$ref;
  if (typeof ref !== 'string') return parameter;
  const named =
    getMergedOpenApiSpec().components.parameters[ref.split('/').pop() ?? ''];
  return isObjectRecord(named) ? named : null;
};

const queryParameters = (): QueryParameter[] => {
  const { paths } = getMergedOpenApiSpec();
  return Object.entries(paths).flatMap(([path, pathItem]) => {
    if (!isObjectRecord(pathItem)) return [];
    const shared = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];
    return Object.entries(pathItem)
      .filter(([method]) => {
        return HTTP_METHODS.has(method);
      })
      .flatMap(([method, operation]) => {
        const own =
          isObjectRecord(operation) && Array.isArray(operation.parameters)
            ? operation.parameters
            : [];
        return [...shared, ...own].flatMap((declared) => {
          const parameter = resolveParameter(declared);
          if (!parameter || parameter.in !== 'query') return [];
          return [{ label: `${method.toUpperCase()} ${path}`, parameter }];
        });
      });
  });
};

const nameOf = (parameter: Record<string, unknown>): string => {
  return typeof parameter.name === 'string' ? parameter.name : '';
};

const isRepeatableEnum = (parameter: Record<string, unknown>): boolean => {
  const { schema } = parameter;
  if (!isObjectRecord(schema) || schema.type !== 'array') return false;
  if (!isObjectRecord(schema.items)) return false;
  const items = schema.items;
  const hasEnum =
    (Array.isArray(items.enum) && items.enum.length > 0) ||
    typeof items.$ref === 'string';
  return hasEnum && parameter.style === 'form' && parameter.explode === true;
};

// `ctx.query.status`, `ctx.query['automation_status']`, `parseString(…)`, and
// a `status` key destructured off `ctx.query`.
const directStatusReads = (source: string): string[] => {
  const reads = [
    ...source.matchAll(/ctx\.query\.((?:\w+_)?status)\b/g),
    ...source.matchAll(/ctx\.query\['((?:\w+_)?status)'\]/g),
  ].map((match) => {
    return match[1];
  });
  for (const match of source.matchAll(
    /const\s*\{([^}]*)\}\s*=\s*ctx\.query/gs
  )) {
    for (const part of match[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (STATUS_NAME.test(name)) reads.push(name);
    }
  }
  return reads;
};

describe('list filter shape contract', () => {
  test('the specs declare status filters at all', () => {
    const statusFilters = queryParameters().filter(({ parameter }) => {
      return STATUS_NAME.test(nameOf(parameter));
    });

    expect(statusFilters.length).toBeGreaterThanOrEqual(10);
  });

  test('every status filter is a repeatable enum', () => {
    const offenders = queryParameters()
      .filter(({ parameter }) => {
        return (
          STATUS_NAME.test(nameOf(parameter)) && !isRepeatableEnum(parameter)
        );
      })
      .map(({ label, parameter }) => {
        return `${nameOf(parameter)} — ${label}`;
      });

    expect(offenders).toEqual([]);
  });

  test('every time range is from/to', () => {
    const offenders = queryParameters()
      .filter(({ parameter }) => {
        return TIME_RANGE_NAME.test(nameOf(parameter));
      })
      .map(({ label, parameter }) => {
        return `${nameOf(parameter)} — ${label}`;
      });

    expect(offenders).toEqual([]);
  });

  test.each(
    readdirSync(ROUTES_DIR).filter((file) => {
      return file.endsWith('.ts');
    })
  )('%s reads every status filter through parseEnumListQuery', (file) => {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf-8');

    expect(directStatusReads(source)).toEqual([]);
  });
});
