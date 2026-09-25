import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A page boundary is only stable over a total order: rows that tie on the sort
 * key come back in scan order, which two queries need not share, so walking the
 * pages repeats one row and never returns another. `paginatedList` appends the
 * primary key to every list's order, so a tie is broken the same way on every
 * page. Actors stand in for every list: the order is decided in one place.
 */
describe('Pagination order', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'pageorder',
      policyActions: ['actors:CreateActor', 'actors:ListActors'],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  // Ties every row on `created_at`, then re-inserts them in reverse id order so
  // both heap and index order are the opposite of insertion order.
  const tieAndReverse = async (args: { table: string; ids: number[] }) => {
    await db.sequelize.query(
      `UPDATE ${args.table} SET created_at = :at WHERE id IN (:ids)`,
      {
        replacements: {
          at: new Date('2026-01-01T00:00:00.000Z'),
          ids: args.ids,
        },
      }
    );
    await db.sequelize.query(
      `WITH moved AS (DELETE FROM ${args.table} WHERE id IN (:ids) RETURNING *)
       INSERT INTO ${args.table} SELECT * FROM moved ORDER BY id DESC`,
      { replacements: { ids: args.ids } }
    );
  };

  describe('GET /api/v1/actors', () => {
    test('one-row pages over tied rows return every row once, in insertion order', async () => {
      const created: string[] = [];
      for (const name of ['first', 'second', 'third']) {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/actors')
          .send({ project_id: projectId, name });
        expect(res.status).toBe(201);
        created.push(res.body.id as string);
      }
      const rows = await db.Actor.findAll({ where: { publicId: created } });
      await tieAndReverse({
        table: 'actors',
        ids: rows.map((row) => {
          return row.id as number;
        }),
      });

      const paged: string[] = [];
      for (let offset = 0; offset < created.length; offset += 1) {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/actors?project_id=${projectId}&limit=1&offset=${offset}`
        );
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(created.length);
        paged.push(res.body.data[0].id as string);
      }

      expect(paged).toEqual(created);
    });
  });
});
