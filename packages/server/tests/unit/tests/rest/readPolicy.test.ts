import { Op } from '@ttoss/postgresdb';
import type { PolicyDocument } from 'src/lib/iam';
import {
  compilePolicy,
  registerResourceFieldMap,
} from 'src/lib/policyCompiler';
import { compileAcrossPolicySets } from 'src/rest/v1/readPolicy';

registerResourceFieldMap({
  resourceType: 'readPolicyResource',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path' },
  tagsColumn: { column: 'tags' },
});

const ACTION = 'documents:ListDocuments';

const allowAll: PolicyDocument = {
  statement: [{ effect: 'Allow', action: [ACTION], resource: ['*'] }],
};

const denyPrivate: PolicyDocument = {
  statement: [
    { effect: 'Allow', action: [ACTION], resource: ['*'] },
    {
      effect: 'Deny',
      action: [ACTION],
      resource: ['srn:proj_b:readPolicyResource:/private/*'],
    },
  ],
};

const compile = (
  policySets: Parameters<typeof compileAcrossPolicySets>[0]['policySets']
) => {
  return compileAcrossPolicySets({
    policySets,
    action: ACTION,
    resourceType: 'readPolicyResource',
  });
};

describe('compileAcrossPolicySets', () => {
  test('no policy set leaves the read unrestricted', () => {
    expect(compile([])).toEqual({ where: {}, hasAccess: true });
  });

  test('one set without access denies the whole read', () => {
    expect(
      compile([
        { projectPublicId: 'proj_a', policies: [[allowAll]] },
        { projectPublicId: 'proj_b', policies: [] },
      ])
    ).toEqual({ where: {}, hasAccess: false });
  });

  test('distinct sets require every row to pass each set', () => {
    const denyWhere = compilePolicy({
      policies: [[denyPrivate]],
      action: ACTION,
      resourceType: 'readPolicyResource',
      projectPublicId: 'proj_b',
    }).where;

    const result = compile([
      { projectPublicId: 'proj_a', policies: [[allowAll]] },
      { projectPublicId: 'proj_b', policies: [[denyPrivate]] },
    ]);

    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({ [Op.and]: [{}, denyWhere] });
  });
});
