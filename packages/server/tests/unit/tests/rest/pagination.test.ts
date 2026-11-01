import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

type Parameter = {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
};

/**
 * Every list pages by cursor through one contract: a first page, a
 * `next_cursor` that is `null` on the last page, `400 INVALID_CURSOR` for a
 * malformed cursor or one sent with other filters, and no repeated row when
 * one is inserted between two pages.
 */
describe('list pagination', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'paging',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  const get = (path: string, query: Record<string, string>) => {
    return authenticatedTestClient(adminToken)
      .get(path)
      .query({ project_id: projectId, ...query });
  };

  /** A list whose operation takes no `project_id` refuses one. */
  const getUnscoped = (path: string, query: Record<string, string>) => {
    return authenticatedTestClient(adminToken).get(path).query(query);
  };

  /**
   * Every list operation reachable without a parent id or a required filter:
   * the lists nested under a resource share the same `paginatedList`, and
   * their own tests page them.
   */
  const topLevelLists = Object.entries(getMergedOpenApiSpec().paths).flatMap(
    ([path, item]) => {
      const operation = (item as { get?: { parameters?: Parameter[] } }).get;
      const parameters = operation?.parameters ?? [];
      const paged = parameters.some((parameter) => {
        return parameter.$ref?.endsWith('/parameters/Cursor');
      });
      const needsInput =
        path.includes('{') ||
        parameters.some((parameter) => {
          return parameter.required && parameter.name !== 'project_id';
        });
      const scoped = parameters.some((parameter) => {
        return parameter.name === 'project_id';
      });
      return paged && !needsInput ? [{ path, scoped }] : [];
    }
  );

  test('finds the lists it walks', () => {
    expect(topLevelLists.length).toBeGreaterThan(30);
  });

  describe.each(topLevelLists)('GET $path', ({ path, scoped }) => {
    const list = (query: Record<string, string>) => {
      return scoped ? get(path, query) : getUnscoped(path, query);
    };

    test('answers a page', async () => {
      const response = await list({ limit: '1' });

      expect(response.status).toBe(200);
      // A report carries its page under one property (`groups`).
      const page = response.body.groups ?? response.body;
      expect(Array.isArray(page.data)).toBe(true);
      expect(page.data.length).toBeLessThanOrEqual(1);
      expect(page).not.toHaveProperty('total');
      expect(
        page.next_cursor === null || typeof page.next_cursor === 'string'
      ).toBe(true);
    });

    test('refuses a malformed cursor', async () => {
      const response = await list({ cursor: 'not-a-cursor' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_CURSOR');
    });

    test('refuses offset', async () => {
      const response = await list({ offset: '0' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe.each([
    { path: '/api/v1/secrets', max: 100 },
    { path: '/api/v1/actors', max: 100 },
    { path: '/api/v1/audit-log', max: 200 },
    { path: '/api/v1/activity', max: 100 },
  ])('limit on $path', ({ path, max }) => {
    test.each([
      { limit: 'abc' },
      { limit: '1.5' },
      { limit: '10abc' },
      { limit: '0' },
      { limit: '-1' },
    ])('refuses %o', async (query) => {
      const response = await get(path, query);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('clamps a limit above the ceiling', async () => {
      const response = await get(path, { limit: String(max + 1) });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(max);
    });
  });

  describe('a walk across pages', () => {
    const createActor = async (name: string): Promise<string> => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name });
      expect(response.status).toBe(201);
      return response.body.id as string;
    };

    const ids = (rows: { id: string }[]) => {
      return rows.map((row) => {
        return row.id;
      });
    };

    /**
     * A day back, so it sorts before the rows already walked, where an offset
     * page would repeat one. `createdAt` is wall-clock: a stepped clock sorts a
     * row created at the real time anywhere.
     */
    const createActorInThePast = async (name: string): Promise<string> => {
      jest.useFakeTimers({ advanceTimers: true });
      jest.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
      try {
        return await createActor(name);
      } finally {
        jest.useRealTimers();
      }
    };

    test('reaches next_cursor null, and a row inserted between pages repeats none', async () => {
      const before = [
        await createActor('walk-a'),
        await createActor('walk-b'),
        await createActor('walk-c'),
      ];

      const seen: string[] = [];
      let cursor: string | undefined;
      let inserted: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const response = await get('/api/v1/actors', {
          limit: '1',
          ...(cursor ? { cursor } : {}),
        });
        expect(response.status).toBe(200);
        seen.push(...ids(response.body.data));
        inserted ??= await createActorInThePast('walk-inserted');
        if (response.body.next_cursor === null) break;
        cursor = response.body.next_cursor as string;
      }

      const listing = ids(
        (await get('/api/v1/actors', { limit: '100' })).body.data
      );
      expect(listing[0]).toBe(inserted);
      expect(seen).toEqual(listing.slice(1));
      expect(seen).toEqual(expect.arrayContaining(before));
    });

    test('refuses a cursor sent with other filters', async () => {
      await createActor('filter-a');
      await createActor('filter-b');
      const first = await get('/api/v1/actors', { limit: '1' });
      expect(first.body.next_cursor).toEqual(expect.any(String));

      const response = await get('/api/v1/actors', {
        limit: '1',
        name: 'filter-a',
        cursor: first.body.next_cursor,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_CURSOR');
    });

    test('accepts a cursor with the same filters and another limit', async () => {
      await createActor('limit-a');
      await createActor('limit-b');
      const first = await get('/api/v1/actors', { limit: '1' });

      const response = await get('/api/v1/actors', {
        limit: '5',
        cursor: first.body.next_cursor,
      });

      expect(response.status).toBe(200);
      expect(
        response.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).not.toContain(first.body.data[0].id);
    });
  });
});
