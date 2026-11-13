import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import {
  BUILT_IN_ACTION_RESOURCE_TYPES,
  UNTYPED_BUILT_IN_MODULES,
} from 'src/lib/iamActionResourceTypes';
import { listAllActions } from 'src/lib/permissionCatalog';
import { resourceTypeOfKind } from 'src/lib/resourceScopes';

const routesDir = path.resolve(__dirname, '../../../../src/rest/v1');
const specDir = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

const actionModules = (): Set<string> => {
  return new Set(
    [...listAllActions()].map((action) => {
      return action.split(':')[0];
    })
  );
};

const routeSources = (): Array<{ file: string; lines: string[] }> => {
  return fs
    .readdirSync(routesDir)
    .filter((file) => {
      return file.endsWith('.ts');
    })
    .map((file) => {
      return {
        file,
        lines: fs.readFileSync(path.join(routesDir, file), 'utf-8').split('\n'),
      };
    });
};

const literalTypes = (text: string): string[] => {
  return [...text.matchAll(/resourceType: '([A-Za-z_]+)'(?! \|)/g)].map(
    (match) => {
      return match[1];
    }
  );
};

/** Each route helper's name with the SRN types its body authorizes on. */
const helperTypes = (): Map<string, string[]> => {
  const helpers = new Map<string, string[]>();
  for (const { lines } of routeSources()) {
    for (const [index, line] of lines.entries()) {
      const name = /^(?:export )?const (\w+) = async/.exec(line)?.[1];
      if (!name) continue;
      const end = lines.findIndex((next, at) => {
        return at > index && next === '};';
      });
      const body = lines.slice(index, end === -1 ? undefined : end).join('\n');
      helpers.set(name, literalTypes(body));
    }
  }
  return helpers;
};

/**
 * Each `<module>:<Action>` a route authorizes with the SRN types written
 * beside it, or inside the route helper it is passed to.
 */
const routePairs = (): Array<{
  file: string;
  action: string;
  type: string;
}> => {
  const helpers = helperTypes();
  return routeSources().flatMap(({ file, lines }) => {
    return lines.flatMap((line, index) => {
      const action = /'([a-z-]+:[A-Za-z]+)'/.exec(line)?.[1];
      if (!action) return [];
      const before = lines.slice(Math.max(0, index - 4), index + 1).join('\n');
      const helper = [...before.matchAll(/(\w+)\(\{/g)].pop()?.[1];
      const near = lines.slice(Math.max(0, index - 3), index + 9).join('\n');
      return [
        ...literalTypes(near),
        ...((helper && helpers.get(helper)) ?? []),
      ].map((type) => {
        return { file, action, type };
      });
    });
  });
};

type SpecOperation = {
  operationId: string;
  action: string;
  module: string;
  resourceType?: unknown;
  kind?: string;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

const specOperations = (): SpecOperation[] => {
  return fs
    .readdirSync(specDir)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .flatMap((file) => {
      const spec = load(fs.readFileSync(path.join(specDir, file), 'utf-8')) as {
        paths?: Record<string, Record<string, Record<string, unknown>>>;
      };
      return Object.values(spec.paths ?? {}).flatMap((item) => {
        return HTTP_METHODS.flatMap((method) => {
          const op = item[method];
          const action = op?.['x-iam-action'];
          if (typeof action !== 'string') return [];
          const resource = op['x-soat-resource'] as
            { kind?: string } | undefined;
          return [
            {
              operationId: String(op.operationId),
              action,
              module: action.split(':')[0],
              resourceType: op['x-iam-resource-type'],
              kind: resource?.kind,
            },
          ];
        });
      });
    });
};

describe('BUILT_IN_ACTION_RESOURCE_TYPES', () => {
  test('classifies every built-in module exactly once', () => {
    const typed = Object.keys(BUILT_IN_ACTION_RESOURCE_TYPES);
    const untyped = Object.keys(UNTYPED_BUILT_IN_MODULES);

    expect(
      [...typed, ...untyped].sort((a, b) => {
        return a.localeCompare(b);
      })
    ).toEqual(
      [...actionModules()].sort((a, b) => {
        return a.localeCompare(b);
      })
    );
  });

  test('holds every SRN type a route authorizes its module action on', () => {
    const pairs = routePairs();
    expect(pairs.length).toBeGreaterThan(50);

    const missing = pairs.filter(({ action, type }) => {
      const types: readonly string[] | undefined =
        BUILT_IN_ACTION_RESOURCE_TYPES[action.split(':')[0]];
      return types !== undefined && !types.includes(type);
    });

    expect(missing).toEqual([]);
  });
});

/**
 * `x-iam-resource-type` is the SRN type an operation's route first authorizes
 * its action on: `POST /api/v1/iam/check` answers that action on
 * `srn:<project>:<x-iam-resource-type>:*`.
 */
describe('x-iam-resource-type', () => {
  const operations = specOperations();
  const routeTypes = new Map<string, Set<string>>();
  for (const { action, type } of routePairs()) {
    routeTypes.set(action, (routeTypes.get(action) ?? new Set()).add(type));
  }

  test('reads operations from disk', () => {
    expect(operations.length).toBeGreaterThan(300);
  });

  test('an untyped module declares none', () => {
    const declared = operations.filter(({ module, resourceType }) => {
      return module in UNTYPED_BUILT_IN_MODULES && resourceType !== undefined;
    });

    expect(declared).toEqual([]);
  });

  test('every typed operation declares a type iam/check accepts', () => {
    const wrong = operations.filter(({ module, resourceType }) => {
      const types: readonly string[] | undefined =
        BUILT_IN_ACTION_RESOURCE_TYPES[module];
      if (!types) return false;
      return typeof resourceType !== 'string' || !types.includes(resourceType);
    });

    expect(wrong).toEqual([]);
  });

  test('an operation naming its resource declares the type that resource authorizes on', () => {
    const wrong = operations.filter(({ kind, resourceType }) => {
      return (
        kind !== undefined && resourceType !== resourceTypeOfKind({ kind })
      );
    });

    expect(wrong).toEqual([]);
  });

  test('any other operation of a multi-type module declares a type its route checks', () => {
    const wrong = operations.filter(
      ({ module, action, kind, resourceType }) => {
        const types = BUILT_IN_ACTION_RESOURCE_TYPES[module] ?? [];
        if (kind !== undefined || types.length < 2) return false;
        return !routeTypes.get(action)?.has(String(resourceType));
      }
    );

    expect(wrong).toEqual([]);
  });
});
