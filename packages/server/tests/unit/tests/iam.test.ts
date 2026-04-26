import {
  buildSrn,
  evaluateCondition,
  evaluatePolicies,
  matchesPattern,
  type PolicyDocument,
  statementMatches,
  validatePolicyDocument,
} from '../../../src/lib/iam';

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
