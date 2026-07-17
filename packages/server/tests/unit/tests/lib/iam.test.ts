import {
  buildSrn,
  evaluateCondition,
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  extractProjectIdsFromPolicies,
  matchesPattern,
  type PolicyDocument,
  statementMatches,
  validatePolicyActions,
  validatePolicyDocument,
} from 'src/lib/iam';

describe('IAM', () => {
  describe('validatePolicyDocument', () => {
    test('valid document with Allow statement passes', () => {
      const doc: PolicyDocument = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('valid document with all fields passes', () => {
      const doc: PolicyDocument = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile', 'files:*'],
            resource: ['soat:proj_ABC:file:*'],
            condition: {
              StringEquals: { 'soat:tag:env': 'prod' },
            },
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(true);
    });

    test('invalid effect fails', () => {
      const doc = {
        statement: [{ effect: 'Grant', action: ['files:GetFile'] }],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('effect');
        })
      ).toBe(true);
    });

    test('empty action array fails', () => {
      const doc = { statement: [{ effect: 'Allow', action: [] }] };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('action');
        })
      ).toBe(true);
    });

    test('invalid action format fails', () => {
      const doc = {
        statement: [{ effect: 'Allow', action: ['invalid-action'] }],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
    });

    test('wildcard * action passes', () => {
      const doc = { statement: [{ effect: 'Allow', action: ['*'] }] };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(true);
    });

    test('module:* action passes', () => {
      const doc = { statement: [{ effect: 'Allow', action: ['files:*'] }] };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(true);
    });

    test('invalid SRN format fails', () => {
      const doc = {
        statement: [
          { effect: 'Allow', action: ['files:GetFile'], resource: ['invalid'] },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('resource');
        })
      ).toBe(true);
    });

    test('valid SRN with wildcard passes', () => {
      const doc = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            resource: ['soat:proj_123:file:*'],
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(true);
    });

    test('invalid condition operator fails', () => {
      const doc = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            condition: { InvalidOp: { 'soat:tag:env': 'prod' } },
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('operator');
        })
      ).toBe(true);
    });

    test('condition key not starting with soat: fails', () => {
      const doc = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            condition: { StringEquals: { env: 'prod' } },
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
    });

    test('non-object input fails', () => {
      const result = validatePolicyDocument('invalid');
      expect(result.valid).toBe(false);
    });

    test('missing statement array fails', () => {
      const result = validatePolicyDocument({ foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('statement');
        })
      ).toBe(true);
    });

    test('resource present but not an array fails', () => {
      const doc = {
        statement: [
          { effect: 'Allow', action: ['files:GetFile'], resource: 'nope' },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('resource');
        })
      ).toBe(true);
    });

    test('empty resource array fails', () => {
      const doc = {
        statement: [
          { effect: 'Allow', action: ['files:GetFile'], resource: [] },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('resource');
        })
      ).toBe(true);
    });

    test('condition operator block that is not an object fails', () => {
      const doc = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            condition: { StringEquals: 'not-an-object' },
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('must be an object');
        })
      ).toBe(true);
    });

    test('condition that is an array fails', () => {
      const doc = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            condition: ['not-an-object'],
          },
        ],
      };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('condition');
        })
      ).toBe(true);
    });

    test('statement entry that is not an object fails', () => {
      const doc = { statement: ['not-an-object', null] };
      const result = validatePolicyDocument(doc);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('must be an object');
        })
      ).toBe(true);
    });
  });

  describe('validatePolicyActions', () => {
    test('non-object document is treated as valid (no actions to check)', () => {
      expect(validatePolicyActions(null).valid).toBe(true);
      expect(validatePolicyActions([]).valid).toBe(true);
    });

    test('document without a statement array is valid', () => {
      expect(validatePolicyActions({ foo: 'bar' }).valid).toBe(true);
    });

    test('statement entry that is not an object is skipped', () => {
      const result = validatePolicyActions({ statement: ['nope', null] });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('statement with a non-array action is skipped', () => {
      const result = validatePolicyActions({
        statement: [{ effect: 'Allow', action: 'files:GetFile' }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('unknown action produces an error', () => {
      const result = validatePolicyActions({
        statement: [{ effect: 'Allow', action: ['files:NotARealAction'] }],
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => {
          return e.includes('not a known action');
        })
      ).toBe(true);
    });

    test('known action passes', () => {
      const result = validatePolicyActions({
        statement: [{ effect: 'Allow', action: ['*'] }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('buildSrn', () => {
    test('produces correct SRN string', () => {
      const srn = buildSrn({
        projectPublicId: 'proj_ABC',
        resourceType: 'file',
        resourceId: 'file_123',
      });
      expect(srn).toBe('soat:proj_ABC:file:file_123');
    });

    test('works with different resource types', () => {
      expect(
        buildSrn({
          projectPublicId: 'p',
          resourceType: 'document',
          resourceId: 'd',
        })
      ).toBe('soat:p:document:d');
    });
  });

  describe('matchesPattern', () => {
    test('* matches everything', () => {
      expect(matchesPattern({ pattern: '*', value: 'files:GetFile' })).toBe(
        true
      );
    });

    test('module:* matches module actions', () => {
      expect(
        matchesPattern({ pattern: 'files:*', value: 'files:GetFile' })
      ).toBe(true);
      expect(
        matchesPattern({ pattern: 'files:*', value: 'actors:GetActor' })
      ).toBe(false);
    });

    test('exact match works', () => {
      expect(
        matchesPattern({ pattern: 'files:GetFile', value: 'files:GetFile' })
      ).toBe(true);
      expect(
        matchesPattern({ pattern: 'files:GetFile', value: 'files:DeleteFile' })
      ).toBe(false);
    });

    test('SRN resource wildcard matches', () => {
      expect(
        matchesPattern({
          pattern: 'soat:proj_ABC:file:*',
          value: 'soat:proj_ABC:file:file_123',
        })
      ).toBe(true);
      expect(
        matchesPattern({
          pattern: 'soat:proj_ABC:file:*',
          value: 'soat:proj_XYZ:file:file_123',
        })
      ).toBe(false);
    });
  });

  describe('evaluateCondition', () => {
    test('StringEquals passes when values match', () => {
      expect(
        evaluateCondition({
          condition: { StringEquals: { 'soat:tag:env': 'prod' } },
          context: { 'soat:tag:env': 'prod' },
        })
      ).toBe(true);
    });

    test('StringEquals fails when values differ', () => {
      expect(
        evaluateCondition({
          condition: { StringEquals: { 'soat:tag:env': 'prod' } },
          context: { 'soat:tag:env': 'dev' },
        })
      ).toBe(false);
    });

    test('StringNotEquals passes when values differ', () => {
      expect(
        evaluateCondition({
          condition: { StringNotEquals: { 'soat:tag:env': 'prod' } },
          context: { 'soat:tag:env': 'dev' },
        })
      ).toBe(true);
    });

    test('StringLike with glob matches', () => {
      expect(
        evaluateCondition({
          condition: { StringLike: { 'soat:tag:env': 'prod*' } },
          context: { 'soat:tag:env': 'production' },
        })
      ).toBe(true);
    });

    test('multiple operators require all to pass (AND logic)', () => {
      expect(
        evaluateCondition({
          condition: {
            StringEquals: { 'soat:tag:env': 'prod' },
            StringNotEquals: { 'soat:tag:region': 'us-east-1' },
          },
          context: { 'soat:tag:env': 'prod', 'soat:tag:region': 'eu-west-1' },
        })
      ).toBe(true);

      expect(
        evaluateCondition({
          condition: {
            StringEquals: { 'soat:tag:env': 'prod' },
            StringNotEquals: { 'soat:tag:region': 'us-east-1' },
          },
          context: { 'soat:tag:env': 'prod', 'soat:tag:region': 'us-east-1' },
        })
      ).toBe(false);
    });

    test('StringLike with a missing context key compares against empty string', () => {
      // actual is undefined → falls back to '' inside evaluateConditionForKey
      expect(
        evaluateCondition({
          condition: { StringLike: { 'soat:tag:env': '*' } },
          context: {},
        })
      ).toBe(true);
      expect(
        evaluateCondition({
          condition: { StringLike: { 'soat:tag:env': 'prod*' } },
          context: {},
        })
      ).toBe(false);
    });

    test('a falsy operator block is skipped', () => {
      expect(
        evaluateCondition({
          // StringEquals block is undefined → the loop continues past it
          condition: { StringEquals: undefined },
          context: {},
        })
      ).toBe(true);
    });

    test('an unrecognized operator is treated as a pass', () => {
      expect(
        evaluateCondition({
          // Unknown operators fall through evaluateConditionForKey to `true`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          condition: { DateGreaterThan: { 'soat:tag:env': 'prod' } } as any,
          context: { 'soat:tag:env': 'dev' },
        })
      ).toBe(true);
    });
  });

  describe('evaluatePoliciesMultiResource', () => {
    const scopedPolicy: PolicyDocument = {
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: ['soat:proj_A:file:*'],
        },
      ],
    };

    test('grants access when one candidate resource matches (default context)', () => {
      // Called without `context` so the `?? {}` default branch is exercised.
      expect(
        evaluatePoliciesMultiResource({
          policies: [scopedPolicy],
          action: 'files:GetFile',
          resources: ['soat:proj_B:file:file_1', 'soat:proj_A:file:file_1'],
        })
      ).toBe(true);
    });

    test('denies when any candidate resource matches a Deny', () => {
      const denyPolicy: PolicyDocument = {
        statement: [
          {
            effect: 'Deny',
            action: ['files:GetFile'],
            resource: ['soat:proj_A:file:*'],
          },
        ],
      };
      expect(
        evaluatePoliciesMultiResource({
          policies: [scopedPolicy, denyPolicy],
          action: 'files:GetFile',
          resources: ['soat:proj_A:file:file_1'],
          context: {},
        })
      ).toBe(false);
    });

    test('returns false when no candidate resource matches an Allow', () => {
      expect(
        evaluatePoliciesMultiResource({
          policies: [scopedPolicy],
          action: 'files:GetFile',
          resources: ['soat:proj_Z:file:file_1'],
        })
      ).toBe(false);
    });
  });

  describe('extractProjectIdsFromPolicies', () => {
    test('collects distinct project ids from Allow statements', () => {
      const result = extractProjectIdsFromPolicies([
        {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: [
                'soat:proj_A:file:*',
                'soat:proj_B:file:*',
                'soat:proj_A:file:file_1',
              ],
            },
          ],
        },
      ]);
      expect(result).toEqual(['proj_A', 'proj_B']);
    });

    test('ignores Deny statements', () => {
      const result = extractProjectIdsFromPolicies([
        {
          statement: [
            {
              effect: 'Deny',
              action: ['files:GetFile'],
              resource: ['soat:proj_A:file:*'],
            },
          ],
        },
      ]);
      expect(result).toEqual([]);
    });

    test('skips resources that are not soat SRNs or are too short', () => {
      const result = extractProjectIdsFromPolicies([
        {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: ['other:thing', 'soat:proj_A'],
            },
          ],
        },
      ]);
      expect(result).toEqual([]);
    });

    test('returns undefined for a wildcard * resource', () => {
      const result = extractProjectIdsFromPolicies([
        {
          statement: [
            { effect: 'Allow', action: ['files:GetFile'], resource: ['*'] },
          ],
        },
      ]);
      expect(result).toBeUndefined();
    });

    test('returns undefined for a wildcard project segment', () => {
      const result = extractProjectIdsFromPolicies([
        {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: ['soat:*:file:file_1'],
            },
          ],
        },
      ]);
      expect(result).toBeUndefined();
    });
  });

  describe('statementMatches', () => {
    const baseStatement = {
      effect: 'Allow' as const,
      action: ['files:GetFile'],
      resource: ['soat:proj_ABC:file:*'],
    };

    test('matches when action and resource match', () => {
      expect(
        statementMatches({
          statement: baseStatement,
          action: 'files:GetFile',
          resource: 'soat:proj_ABC:file:file_123',
          context: {},
        })
      ).toBe(true);
    });

    test('does not match wrong action', () => {
      expect(
        statementMatches({
          statement: baseStatement,
          action: 'files:DeleteFile',
          resource: 'soat:proj_ABC:file:file_123',
          context: {},
        })
      ).toBe(false);
    });

    test('does not match wrong resource', () => {
      expect(
        statementMatches({
          statement: baseStatement,
          action: 'files:GetFile',
          resource: 'soat:proj_XYZ:file:file_123',
          context: {},
        })
      ).toBe(false);
    });

    test('statement without resource matches any resource', () => {
      const stmt = { effect: 'Allow' as const, action: ['files:GetFile'] };
      expect(
        statementMatches({
          statement: stmt,
          action: 'files:GetFile',
          resource: 'soat:proj_ABC:file:file_123',
          context: {},
        })
      ).toBe(true);
    });

    test('does not match when condition fails', () => {
      const stmt = {
        ...baseStatement,
        condition: { StringEquals: { 'soat:tag:env': 'prod' } },
      };
      expect(
        statementMatches({
          statement: stmt,
          action: 'files:GetFile',
          resource: 'soat:proj_ABC:file:file_123',
          context: { 'soat:tag:env': 'dev' },
        })
      ).toBe(false);
    });
  });

  describe('evaluatePolicies', () => {
    const allowPolicy: PolicyDocument = {
      statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
    };

    const denyPolicy: PolicyDocument = {
      statement: [{ effect: 'Deny', action: ['files:GetFile'] }],
    };

    test('returns false when no policies', () => {
      expect(evaluatePolicies({ policies: [], action: 'files:GetFile' })).toBe(
        false
      );
    });

    test('returns false when no matching statements', () => {
      expect(
        evaluatePolicies({
          policies: [allowPolicy],
          action: 'files:DeleteFile',
        })
      ).toBe(false);
    });

    test('returns true when Allow matches', () => {
      expect(
        evaluatePolicies({ policies: [allowPolicy], action: 'files:GetFile' })
      ).toBe(true);
    });

    test('explicit Deny overrides Allow (Deny wins)', () => {
      expect(
        evaluatePolicies({
          policies: [allowPolicy, denyPolicy],
          action: 'files:GetFile',
        })
      ).toBe(false);
    });

    test('Deny short-circuits even if Allow comes first', () => {
      expect(
        evaluatePolicies({
          policies: [denyPolicy, allowPolicy],
          action: 'files:GetFile',
        })
      ).toBe(false);
    });

    test('resource filtering works', () => {
      const scopedPolicy: PolicyDocument = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            resource: ['soat:proj_A:file:*'],
          },
        ],
      };
      expect(
        evaluatePolicies({
          policies: [scopedPolicy],
          action: 'files:GetFile',
          resource: 'soat:proj_A:file:file_123',
        })
      ).toBe(true);
      expect(
        evaluatePolicies({
          policies: [scopedPolicy],
          action: 'files:GetFile',
          resource: 'soat:proj_B:file:file_123',
        })
      ).toBe(false);
    });

    test('condition filtering works', () => {
      const condPolicy: PolicyDocument = {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            condition: { StringEquals: { 'soat:tag:env': 'prod' } },
          },
        ],
      };
      expect(
        evaluatePolicies({
          policies: [condPolicy],
          action: 'files:GetFile',
          context: { 'soat:tag:env': 'prod' },
        })
      ).toBe(true);
      expect(
        evaluatePolicies({
          policies: [condPolicy],
          action: 'files:GetFile',
          context: { 'soat:tag:env': 'dev' },
        })
      ).toBe(false);
    });
  });
});
