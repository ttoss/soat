/**
 * A pure algorithm: action globs × resource forms × the project group's live
 * projects. Every entry point also confines its credential to the project
 * group, so a resource left outside it cannot be told apart over HTTP.
 */
import { scopeProjectGroupPolicyDocument } from 'src/lib/projectGroupPolicies';

const projectGroup = { publicId: 'pgrp_a', projectPublicIds: ['proj_in'] };

describe('scopeProjectGroupPolicyDocument', () => {
  test('an Allow without resource reaches the project group and its projects, each by its actions', () => {
    const scoped = scopeProjectGroupPolicyDocument({
      projectGroup,
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['project-groups:GetUsage', 'secrets:*', '*'],
          },
        ],
      },
    });
    expect(scoped.statement).toEqual([
      {
        effect: 'Allow',
        action: ['project-groups:GetUsage'],
        resource: ['srn:project-group:pgrp_a:*'],
      },
      {
        effect: 'Allow',
        action: ['secrets:*'],
        resource: ['srn:proj_in:*:*'],
      },
      {
        effect: 'Allow',
        action: ['*'],
        resource: ['srn:project-group:pgrp_a:*', 'srn:proj_in:*:*'],
      },
    ]);
  });

  test('a resource outside the project group now grants nothing', () => {
    const scoped = scopeProjectGroupPolicyDocument({
      projectGroup,
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['secrets:*'],
            resource: ['srn:proj_left:secret:*', 'srn:proj_in:secret:*'],
          },
          {
            effect: 'Allow',
            action: ['secrets:*'],
            resource: ['srn:proj_left:secret:*'],
          },
          { effect: 'Deny', action: ['secrets:*'], resource: ['*'] },
        ],
      },
    });
    expect(scoped.statement).toEqual([
      {
        effect: 'Allow',
        action: ['secrets:*'],
        resource: ['srn:proj_in:secret:*'],
      },
      { effect: 'Deny', action: ['secrets:*'], resource: ['*'] },
    ]);
  });
});
