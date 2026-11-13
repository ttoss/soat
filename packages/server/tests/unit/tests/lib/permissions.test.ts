import type { PolicyDocument } from 'src/lib/iam';
import { createPolicySetsIsAllowed } from 'src/lib/permissions';

/**
 * Direct tests for the authorizer every project authorization in the codebase
 * funnels through. It is the security-critical decision point and the only
 * place that can give "the route resolved no project" a single, safe outcome
 * for every module at once — and no entry point can produce that input on
 * purpose, which is why it is covered here rather than through REST.
 *
 * The input arises when a lib mapper hands a permission check an object whose
 * `project_id` is absent (a camelCase twin holds the value) or empty (an
 * association the query forgot to `include`). Both are undetectable by types:
 * `projectPublicId: string` is satisfied by a `!`-asserted `undefined`.
 */
describe('project authorizer rejects a check that names no project', () => {
  const cases: [string, string][] = [
    ['empty string', ''],
    // `doc.project_id!` on an object missing the field.
    ['undefined', undefined as unknown as string],
  ];

  // An admin's set — the most permissive there is, so a denial here can only
  // come from the missing project.
  const ADMIN: PolicyDocument[] = [
    { statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }] },
  ];

  describe.each([
    ['pinned to a project', 'prj_any'],
    ['bound to no project', undefined],
  ])('a credential %s', (_label, pinned) => {
    const isAllowed = createPolicySetsIsAllowed({
      projectPublicId: pinned,
      getSets: async () => {
        return [{ principal: { type: 'user', id: 'usr_any' }, sets: [ADMIN] }];
      },
    });

    test.each(cases)('denies with an %s project id', async (_case, value) => {
      await expect(
        isAllowed({ projectPublicId: value, action: 'documents:GetDocument' })
      ).resolves.toBe(false);
    });

    test('allows when the project is named', async () => {
      await expect(
        isAllowed({
          projectPublicId: 'prj_any',
          action: 'documents:GetDocument',
        })
      ).resolves.toBe(true);
    });
  });
});

describe('project authorizer names the set that refused', () => {
  const allow = (action: string): PolicyDocument[] => {
    return [{ statement: [{ effect: 'Allow', action: [action] }] }];
  };
  const key = { type: 'api_key', id: 'key_any' } as const;
  const bound = { type: 'iam_token', id: 'jti_any' } as const;
  const isAllowed = createPolicySetsIsAllowed({
    projectPublicId: 'prj_any',
    getSets: async () => {
      return [
        { principal: key, sets: [allow('documents:*')] },
        { principal: bound, sets: [allow('documents:GetDocument')] },
      ];
    },
  });
  const resource = 'srn:prj_any:document:doc_any';

  test('names the bound where only the bound refuses', async () => {
    await isAllowed({
      projectPublicId: 'prj_any',
      action: 'documents:DeleteDocument',
      resource,
    });

    expect(
      isAllowed.refusedBy({ action: 'documents:DeleteDocument', resource })
    ).toEqual(bound);
  });

  test('names the first refusing set where both refuse', async () => {
    await isAllowed({ projectPublicId: 'prj_any', action: 'tools:GetTool' });

    expect(
      isAllowed.refusedBy({ action: 'tools:GetTool', resource: null })
    ).toEqual(key);
  });

  test('names none for a refusal by the project scope', async () => {
    await isAllowed({
      projectPublicId: 'prj_other',
      action: 'agents:GetAgent',
    });

    expect(
      isAllowed.refusedBy({ action: 'agents:GetAgent', resource: null })
    ).toBeUndefined();
  });
});
