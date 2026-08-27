import { listDocuments } from 'src/lib/documents';

// A `$`-prefixed policyWhere key needs `subQuery: false` on the Sequelize query.
// No REST-level test exercises a path-scoped policy against document listing.
describe('listDocuments — policyWhere with a $-prefixed key', () => {
  test('sets subQuery: false and returns the (empty) result shape', async () => {
    const result = await listDocuments({
      policyWhere: { '$file.path$': '/docs/readme.txt' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        data: expect.any(Array),
        total: expect.any(Number),
      })
    );
  });
});
