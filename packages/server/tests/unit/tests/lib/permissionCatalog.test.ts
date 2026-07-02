import {
  getPermissionCatalog,
  listAllActions,
} from '../../../../src/lib/permissionCatalog';

describe('permissionCatalog', () => {
  describe('when the permissions directory cannot be found', () => {
    test('returns an empty catalog instead of throwing', () => {
      jest.isolateModules(() => {
        jest.doMock('node:fs', () => {
          return {
            ...jest.requireActual('node:fs'),
            existsSync: () => {
              return false;
            },
          };
        });

        // jest.isolateModules requires require() for synchronous module loading
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
        const isolated: any = require('../../../../src/lib/permissionCatalog');

        expect(isolated.getPermissionCatalog()).toEqual({ modules: [] });
      });
    });
  });

  describe('getPermissionCatalog', () => {
    test('loads modules with their actions from permissions/*.json', () => {
      const catalog = getPermissionCatalog();

      expect(Array.isArray(catalog.modules)).toBe(true);
      expect(catalog.modules.length).toBeGreaterThan(0);

      const agents = catalog.modules.find((m) => {
        return m.module === 'agents';
      });
      expect(agents).toBeDefined();
      expect(
        agents?.actions.some((a) => {
          return a.action === 'agents:CreateAgent';
        })
      ).toBe(true);
      // every action carries a human description for the consent screen
      for (const action of agents?.actions ?? []) {
        expect(action.action.startsWith('agents:')).toBe(true);
        expect(typeof action.description).toBe('string');
      }
    });

    test('deduplicates actions that map to the same permission', () => {
      const catalog = getPermissionCatalog();
      const agents = catalog.modules.find((m) => {
        return m.module === 'agents';
      });
      const generationActions =
        agents?.actions.filter((a) => {
          return a.action === 'agents:CreateAgentGeneration';
        }) ?? [];
      // createAgentGeneration and submitAgentToolOutputs share one action
      expect(generationActions.length).toBe(1);
    });

    test('modules are sorted and unique', () => {
      const catalog = getPermissionCatalog();
      const names = catalog.modules.map((m) => {
        return m.module;
      });
      expect(names).toEqual([...new Set(names)].sort());
    });
  });

  describe('listAllActions', () => {
    test('returns a flat set of every known action', () => {
      const actions = listAllActions();
      expect(actions.has('agents:CreateAgent')).toBe(true);
      expect(actions.has('projects:GetProject')).toBe(true);
    });
  });
});
