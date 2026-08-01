import { db } from 'src/db';
import { createApiKeyIsAllowed, createJwtIsAllowed } from 'src/lib/permissions';

/**
 * Direct tests for the two authorizer factories every project authorization in
 * the codebase funnels through. They are the security-critical decision point
 * and the only place that can give "the route resolved no project" a single,
 * safe outcome for every module at once — and no entry point can produce that
 * input on purpose, which is why it is covered here rather than through REST.
 *
 * The input arises when a lib mapper hands a permission check an object whose
 * `project_id` is absent (a camelCase twin, as in #801) or empty (an association
 * the query forgot to `include`). Both are undetectable by the caller's types:
 * `projectPublicId: string` is satisfied by a `!`-asserted `undefined`.
 */
describe('project authorizers reject a check that names no project', () => {
  const cases: [string, string][] = [
    ['empty string', ''],
    // `doc.project_id!` on an object missing the field — the #801 shape.
    ['undefined', undefined as unknown as string],
  ];

  describe('createApiKeyIsAllowed (API key / OAuth token)', () => {
    test.each(cases)('denies with an %s project id', async (_label, value) => {
      const isAllowed = createApiKeyIsAllowed({
        // An admin with no key boundary — the most permissive credential there
        // is, so a denial here can only come from the missing project.
        userRole: 'admin',
        userPolicyIds: [],
        apiKeyPolicyIds: [],
        db,
      });

      await expect(
        isAllowed({ projectPublicId: value, action: 'documents:GetDocument' })
      ).resolves.toBe(false);
    });
  });

  describe('createJwtIsAllowed (user session)', () => {
    test.each(cases)('denies with an %s project id', async (_label, value) => {
      const isAllowed = createJwtIsAllowed({
        role: 'admin',
        userPolicyIds: [],
        db,
      });

      await expect(
        isAllowed({ projectPublicId: value, action: 'documents:GetDocument' })
      ).resolves.toBe(false);
    });

    test('still allows an admin when the project is named', async () => {
      const isAllowed = createJwtIsAllowed({
        role: 'admin',
        userPolicyIds: [],
        db,
      });

      await expect(
        isAllowed({
          projectPublicId: 'prj_any',
          action: 'documents:GetDocument',
        })
      ).resolves.toBe(true);
    });
  });
});
