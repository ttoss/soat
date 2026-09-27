import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

import { routes } from '../../../src/generated/routes';
import { createCliTestClient } from '../testClient';

const SPECS_DIR = path.resolve(
  __dirname,
  '../../../../server/src/rest/openapi/v1'
);

type Spec = { paths?: Record<string, Record<string, unknown>> };

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const specs: Record<string, Spec> = Object.fromEntries(
  fs
    .readdirSync(SPECS_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .map((file) => {
      return [
        file,
        load(fs.readFileSync(path.join(SPECS_DIR, file), 'utf8')) as Spec,
      ];
    })
);

const resolveRef = (args: { ref: string; file: string }) => {
  const [target, pointer] = args.ref.split('#');
  const file = target ? path.basename(target) : args.file;
  let node: unknown = specs[file];
  for (const key of (pointer ?? '').split('/').filter(Boolean)) {
    node = isRecord(node) ? node[key] : undefined;
  }
  return { node, file };
};

const jsonBodySchema = (args: {
  operation: Record<string, unknown>;
  file: string;
}): unknown => {
  const body = args.operation.requestBody;
  const content = isRecord(body) ? body.content : undefined;
  const json = isRecord(content) ? content['application/json'] : undefined;
  let schema: unknown = isRecord(json) ? json.schema : undefined;
  let file = args.file;
  while (isRecord(schema) && typeof schema.$ref === 'string') {
    ({ node: schema, file } = resolveRef({ ref: schema.$ref, file }));
  }
  return schema;
};

const namesNoProperty = (schema: unknown): boolean => {
  return (
    isRecord(schema) &&
    !['properties', 'oneOf', 'anyOf', 'allOf'].some((key) => {
      return key in schema;
    })
  );
};

/**
 * Every operation whose JSON body names no property: the manifest derives a
 * flag per body property, so such a body has no flag unless something maps
 * one onto the whole body.
 */
const bareMapBodyOperationIds = (): string[] => {
  return Object.entries(specs)
    .flatMap(([file, spec]) => {
      return Object.values(spec.paths ?? {}).flatMap((pathItem) => {
        return Object.values(pathItem)
          .filter(isRecord)
          .filter((operation) => {
            return namesNoProperty(jsonBodySchema({ operation, file }));
          })
          .map((operation) => {
            return String(operation.operationId);
          });
      });
    })
    .sort();
};

const commandFor = (operationId: string): string => {
  const entry = Object.entries(routes).find(([, route]) => {
    return route.operationId === operationId;
  });
  if (!entry) throw new Error(`No command for ${operationId}`);
  return entry[0];
};

const tagBagCommands = bareMapBodyOperationIds().map(commandFor);

describe('a tag bag body is sent whole by --tags', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const pathFlagsFor = (command: string): string[] => {
    return routes[command as keyof typeof routes].pathParams.flatMap(
      (param) => {
        return [`--${param.replace(/_/g, '-')}`, `${param}_1`];
      }
    );
  };

  test('every bare-map body is a tag bag on a replace or merge command', () => {
    expect(tagBagCommands).toHaveLength(14);
    for (const command of tagBagCommands) {
      expect(command).toMatch(/^(replace|merge)-[a-z-]+-tags$/);
    }
  });

  test.each(tagBagCommands)(
    '%s sends the bag as the request body',
    async (command) => {
      const requests = await cliTestClient.call([
        command,
        ...pathFlagsFor(command),
        '--tags',
        '{"team":"finance","cost_center":"cc-42"}',
      ]);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toEqual({
        team: 'finance',
        cost_center: 'cc-42',
      });
    }
  );

  test('an empty bag is sent, so replace can clear every tag', async () => {
    const requests = await cliTestClient.call([
      'replace-actor-tags',
      '--actor-id',
      'actor_1',
      '--tags',
      '{}',
    ]);

    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.path).toBe('/api/v1/actors/actor_1/tags');
    expect(requests[0]?.body).toEqual({});
  });

  test.each([
    ['missing', []],
    ['an array', ['--tags', '["team"]']],
    ['not JSON', ['--tags', 'team=finance']],
  ])('--tags %s exits 1 without a request', async (_, tagArgs) => {
    const errors: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(line);
    });
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code}`);
    }) as typeof process.exit);

    await expect(
      cliTestClient.call([
        'merge-actor-tags',
        '--actor-id',
        'actor_1',
        ...tagArgs,
      ])
    ).rejects.toThrow('EXIT_1');

    expect(cliTestClient.fetchMock).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/--tags/);
  });

  test('--help lists --tags as a required object flag', async () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code}`);
    }) as typeof process.exit);

    await expect(
      cliTestClient.call(['replace-actor-tags', '--help'])
    ).rejects.toThrow('EXIT_0');

    expect(lines.join('\n')).toMatch(/--tags {2}<object> \[required\]/);
  });
});
