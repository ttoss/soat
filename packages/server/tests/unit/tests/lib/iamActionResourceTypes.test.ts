import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BUILT_IN_ACTION_RESOURCE_TYPES,
  UNTYPED_BUILT_IN_MODULES,
} from 'src/lib/iamActionResourceTypes';
import { listAllActions } from 'src/lib/permissionCatalog';

const routesDir = path.resolve(__dirname, '../../../../src/rest/v1');

const actionModules = (): Set<string> => {
  return new Set(
    [...listAllActions()].map((action) => {
      return action.split(':')[0];
    })
  );
};

/** Each `<module>:<Action>` a route authorizes beside a literal SRN type. */
const routePairs = (): Array<{
  file: string;
  module: string;
  type: string;
}> => {
  return fs
    .readdirSync(routesDir)
    .filter((file) => {
      return file.endsWith('.ts');
    })
    .flatMap((file) => {
      const lines = fs
        .readFileSync(path.join(routesDir, file), 'utf-8')
        .split('\n');
      return lines.flatMap((line, index) => {
        const action = /action: '([a-z-]+):[A-Za-z]+'/.exec(line);
        if (!action) return [];
        const near = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
        return [...near.matchAll(/resourceType: '([A-Za-z_]+)'/g)].map(
          (match) => {
            return { file, module: action[1], type: match[1] };
          }
        );
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

    const missing = pairs.filter(({ module, type }) => {
      const types: readonly string[] | undefined =
        BUILT_IN_ACTION_RESOURCE_TYPES[module];
      return !types?.includes(type);
    });

    expect(missing).toEqual([]);
  });
});
