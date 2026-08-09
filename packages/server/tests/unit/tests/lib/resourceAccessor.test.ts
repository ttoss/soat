import { DomainError } from '../../../../src/errors';
import {
  makeResourceAccessor,
  scopedWhere,
} from '../../../../src/lib/resourceAccessor';

/**
 * Direct coverage for the accessor, justified under the keep-list rule as a
 * pure function with a large input space: `scopedWhere` has to answer for every
 * combination of credential scope (absent / populated / **empty**) and extra
 * predicate, and every resource module now routes its cross-project isolation
 * through this one function.
 *
 * Driving those cases through HTTP would mean a full project + policy + user +
 * resource per case, twenty-plus times over, and the failure signal would be a
 * bare `404` that names neither the branch nor the module. The per-module REST
 * tests still cover that each module *reaches* the accessor; this file covers
 * what the accessor then decides.
 *
 * No database: the model is a recording stub, because what is under test is the
 * `where` that gets built — not what Postgres does with it.
 */

type FindOneCall = {
  where?: Record<string, unknown>;
  include?: unknown;
};

const stubModel = (result: unknown) => {
  const calls: FindOneCall[] = [];
  return {
    calls,
    model: {
      findOne: (options: FindOneCall) => {
        calls.push(options);
        return Promise.resolve(result);
      },
    },
  };
};

describe('scopedWhere (standalone)', () => {
  // The scope rule on its own, for the modules that borrow it without an
  // accessor because a *referenced-entity* miss is their own `400`
  // (`ingestionRuleRefs.ts`, `pipelineTools.ts`).
  test('is the same function the accessor exposes', () => {
    const widgets = makeResourceAccessor<{ id?: unknown }>({
      model: () => {
        return { findOne: () => Promise.resolve(null) };
      },
      label: 'Widget',
    });

    expect(widgets.scopedWhere).toBe(scopedWhere);
  });

  test('an empty scope matches nothing rather than everything', () => {
    expect(scopedWhere({ id: 'tol_1', projectIds: [] })).toEqual({
      publicId: 'tol_1',
      projectId: [],
    });
  });
});

describe('makeResourceAccessor', () => {
  describe('scopedWhere', () => {
    const { model } = stubModel(null);
    const widgets = makeResourceAccessor<{ id?: unknown }>({
      model: () => {
        return model;
      },
      label: 'Widget',
    });

    test('an absent scope leaves the lookup unnarrowed', () => {
      expect(widgets.scopedWhere({ id: 'wid_1' })).toEqual({
        publicId: 'wid_1',
      });
    });

    test('a populated scope narrows the lookup to those projects', () => {
      expect(widgets.scopedWhere({ id: 'wid_1', projectIds: [7, 9] })).toEqual({
        publicId: 'wid_1',
        projectId: [7, 9],
      });
    });

    test('an empty scope matches nothing rather than everything', () => {
      // The isolation guarantee. An empty credential scope must read as "no
      // projects", never as "no filter" — the latter is how a scoped key would
      // see across tenants. `orchestrationStartRun.ts` spelled this as
      // `projectIds.length > 0`, which dropped the filter entirely.
      expect(widgets.scopedWhere({ id: 'wid_1', projectIds: [] })).toEqual({
        publicId: 'wid_1',
        projectId: [],
      });
    });

    test('merges an extra predicate without reading its key', () => {
      expect(
        widgets.scopedWhere({
          id: 'wid_1',
          projectIds: [7],
          where: { deletedAt: null },
        })
      ).toEqual({ publicId: 'wid_1', projectId: [7], deletedAt: null });
    });
  });

  describe('findByPublicId', () => {
    test('queries with the scoped where and the module includes', async () => {
      const includes = [{ model: 'Project', as: 'project' }];
      const stub = stubModel({ id: 42 });
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        includes: () => {
          return includes as never;
        },
        label: 'Widget',
      });

      await widgets.findByPublicId({ id: 'wid_1', projectIds: [3] });

      expect(stub.calls).toEqual([
        { where: { publicId: 'wid_1', projectId: [3] }, include: includes },
      ]);
    });

    test('returns null for a miss instead of throwing', async () => {
      const stub = stubModel(null);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      expect(await widgets.findByPublicId({ id: 'wid_1' })).toBeNull();
    });

    test('omits include entirely for a resource with no associations', async () => {
      const stub = stubModel(null);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      await widgets.findByPublicId({ id: 'wid_1' });

      expect(stub.calls[0].include).toBeUndefined();
    });
  });

  describe('getByPublicId', () => {
    test('returns the row when present', async () => {
      const row = { id: 42 };
      const stub = stubModel(row);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      expect(await widgets.getByPublicId({ id: 'wid_1' })).toBe(row);
    });

    test('throws RESOURCE_NOT_FOUND naming the label and id', async () => {
      const stub = stubModel(null);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      await expect(widgets.getByPublicId({ id: 'wid_1' })).rejects.toThrow(
        new DomainError('RESOURCE_NOT_FOUND', "Widget 'wid_1' not found.")
      );
    });

    test('an out-of-scope id reads as absent, not as forbidden', async () => {
      // Same 404 an unknown id gets, so a resource's existence never leaks
      // across a tenant boundary.
      const stub = stubModel(null);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      const error = await widgets
        .getByPublicId({ id: 'wid_1', projectIds: [] })
        .catch((error_: DomainError) => {
          return error_;
        });

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('RESOURCE_NOT_FOUND');
      expect((error as DomainError).httpStatus).toBe(404);
    });

    test('uses the accessor error code when one is configured', async () => {
      const stub = stubModel(null);
      const runs = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Run',
        errorCode: 'ORCHESTRATION_RUN_NOT_FOUND',
      });

      const error = await runs
        .getByPublicId({ id: 'orun_1' })
        .catch((error_: DomainError) => {
          return error_;
        });

      expect((error as DomainError).code).toBe('ORCHESTRATION_RUN_NOT_FOUND');
    });

    test('a per-call error code overrides the accessor default', async () => {
      // A resource that is a 404 on its own routes but a 400-class
      // referenced-entity miss elsewhere names the second code at the call
      // site, rather than dropping back to a hand-rolled lookup.
      const stub = stubModel(null);
      const chats = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Chat',
      });

      const error = await chats
        .getByPublicId({ id: 'cht_1', errorCode: 'CHAT_NOT_FOUND' })
        .catch((error_: DomainError) => {
          return error_;
        });

      expect((error as DomainError).code).toBe('CHAT_NOT_FOUND');
      expect((error as DomainError).httpStatus).toBe(400);
    });
  });

  describe('reload', () => {
    test('re-reads by internal id with the module includes attached', async () => {
      const includes = [{ model: 'Project', as: 'project' }];
      const stub = stubModel({ id: 42, project: {} });
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        includes: () => {
          return includes as never;
        },
        label: 'Widget',
      });

      const reloaded = await widgets.reload({ id: 42 });

      expect(stub.calls).toEqual([{ where: { id: 42 }, include: includes }]);
      expect(reloaded).toEqual({ id: 42, project: {} });
    });

    test('never narrows by project — the row was just written by its owner', async () => {
      const stub = stubModel({ id: 42 });
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      await widgets.reload({ id: 42 });

      expect(stub.calls[0].where).toEqual({ id: 42 });
    });
  });

  describe('notFound', () => {
    test('builds the error without querying', () => {
      const stub = stubModel(null);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      const error = widgets.notFound('wid_1');

      expect(error).toBeInstanceOf(DomainError);
      expect(error.message).toBe("Widget 'wid_1' not found.");
      expect(stub.calls).toEqual([]);
    });

    test('accepts a caller-supplied code', () => {
      const stub = stubModel(null);
      const widgets = makeResourceAccessor<{ id?: unknown }>({
        model: () => {
          return stub.model;
        },
        label: 'Widget',
      });

      expect(widgets.notFound('wid_1', 'TOOL_NOT_FOUND').code).toBe(
        'TOOL_NOT_FOUND'
      );
    });
  });
});
