import { listDocuments } from 'src/lib/documents';

// A `$`-prefixed policyWhere key (e.g. `$file.path$`, produced by the policy
// compiler for path-scoped policies) requires `subQuery: false` on the
// underlying Sequelize query. No existing REST-level test exercises a
// path-scoped policy against document listing, so it is exercised directly
// here.
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
