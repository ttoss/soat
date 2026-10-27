import { db } from 'src/db';

import { testClient } from '../../testClient';

/**
 * A file of its own: the database must hold no user when the calls race,
 * and every other users test bootstraps first.
 */
describe('POST /api/v1/users/bootstrap concurrently', () => {
  test('exactly one call creates the admin; the rest are refused', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => {
        return testClient
          .post('/api/v1/users/bootstrap')
          .send({ username: `admin${index}`, password: 'supersecret' });
      })
    );

    const statuses = responses.map((response) => {
      return response.status;
    });

    expect(
      statuses.filter((status) => {
        return status === 201;
      })
    ).toHaveLength(1);
    expect(
      responses
        .filter((response) => {
          return response.status !== 201;
        })
        .map((response) => {
          return [response.status, response.body.error.code];
        })
    ).toEqual(Array(4).fill([409, 'BOOTSTRAP_ALREADY_COMPLETED']));
    expect(await db.User.count()).toBe(1);
  });
});
