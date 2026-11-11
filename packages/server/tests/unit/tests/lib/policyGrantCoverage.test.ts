import type { PolicyDocument } from 'src/lib/iam';
import {
  findUncoveredGrants,
  globCovers,
  globOverlaps,
} from 'src/lib/policyGrantCoverage';

const allow = (
  action: string[],
  resource?: string[],
  condition?: PolicyDocument['statement'][number]['condition']
): PolicyDocument => {
  return {
    statement: [
      {
        effect: 'Allow',
        action,
        ...(resource ? { resource } : {}),
        ...(condition ? { condition } : {}),
      },
    ],
  };
};

const uncovered = (args: {
  writer: PolicyDocument[][];
  granted: PolicyDocument;
}) => {
  return findUncoveredGrants({
    writerSets: args.writer,
    policies: [{ policyId: 'pol_x', document: args.granted }],
    projectPublicId: 'proj_a',
  });
};

describe('policyGrantCoverage', () => {
  describe('globCovers', () => {
    test.each([
      ['*', 'agents:GetAgent', true],
      ['agents:*', 'agents:GetAgent', true],
      ['agents:*', 'agents:*', true],
      ['agents:GetAgent', 'agents:*', false],
      ['agents:*', '*', false],
      ['srn:p:*', 'srn:p:agent:*', true],
      ['srn:p:agent:*', 'srn:p:*', false],
      ['srn:p:a?', 'srn:p:a*', false],
      ['srn:p:a*', 'srn:p:a?', true],
      ['srn:p:a?', 'srn:p:ab', true],
    ])('%s covers %s: %s', (outer, inner, expected) => {
      expect(globCovers({ outer, inner })).toBe(expected);
    });
  });

  describe('globOverlaps', () => {
    test.each([
      ['agents:DeleteAgent', 'agents:*', true],
      ['agents:DeleteAgent', 'chats:*', false],
      ['srn:p:agent:x', 'srn:p:agent:*', true],
      ['srn:p:agent:?', 'srn:p:chat:*', false],
      ['*', 'anything', true],
    ])('%s overlaps %s: %s', (a, b, expected) => {
      expect(globOverlaps({ a, b })).toBe(expected);
    });
  });

  describe('findUncoveredGrants', () => {
    test('an admin wildcard covers any grant', () => {
      expect(
        uncovered({
          writer: [[allow(['*'], ['*'])]],
          granted: allow(['*']),
        })
      ).toEqual([]);
    });

    test('a narrower writer does not cover a module wildcard', () => {
      expect(
        uncovered({
          writer: [[allow(['agents:GetAgent', 'agents:ListAgents'])]],
          granted: allow(['agents:*']),
        })
      ).toEqual([
        {
          policy_id: 'pol_x',
          statement: 0,
          action: 'agents:*',
          resource: 'srn:proj_a:*:*',
        },
      ]);
    });

    test('a grant on `*` is read as the trigger project', () => {
      expect(
        uncovered({
          writer: [[allow(['agents:GetAgent'], ['srn:proj_a:*:*'])]],
          granted: allow(['agents:GetAgent']),
        })
      ).toEqual([]);
    });

    test('a grant naming another project is out of reach and ignored', () => {
      expect(
        uncovered({
          writer: [[allow(['agents:GetAgent'], ['srn:proj_a:*:*'])]],
          granted: allow(['agents:*'], ['srn:proj_b:*:*']),
        })
      ).toEqual([]);
    });

    test('a writer resource narrower than the grant does not cover it', () => {
      expect(
        uncovered({
          writer: [[allow(['agents:GetAgent'], ['srn:proj_a:agent:agt_1'])]],
          granted: allow(['agents:GetAgent']),
        })
      ).toHaveLength(1);
    });

    test('a writer Deny overlapping the grant leaves it uncovered', () => {
      const writer: PolicyDocument = {
        statement: [
          { effect: 'Allow', action: ['agents:*'] },
          {
            effect: 'Deny',
            action: ['agents:DeleteAgent'],
            resource: ['srn:proj_a:agent:agt_1'],
          },
        ],
      };
      expect(
        uncovered({ writer: [[writer]], granted: allow(['agents:*']) })
      ).toHaveLength(1);
    });

    test('every policy set of the writer must cover the grant', () => {
      expect(
        uncovered({
          writer: [[allow(['*'])], [allow(['triggers:ListTriggers'])]],
          granted: allow(['agents:GetAgent']),
        })
      ).toHaveLength(1);
    });

    test('a writer with no policy set covers nothing', () => {
      expect(
        uncovered({ writer: [], granted: allow(['agents:GetAgent']) })
      ).toHaveLength(1);
    });

    test('a conditioned writer Allow covers only the same condition', () => {
      const condition = { StringEquals: { 'iam:ResourceTag/team': 'red' } };
      const writer = [[allow(['agents:GetAgent'], undefined, condition)]];
      expect(
        uncovered({
          writer,
          granted: allow(['agents:GetAgent'], undefined, condition),
        })
      ).toEqual([]);
      expect(
        uncovered({ writer, granted: allow(['agents:GetAgent']) })
      ).toHaveLength(1);
    });

    test('Deny statements in the granted policy need no cover', () => {
      expect(
        uncovered({
          writer: [[allow(['agents:GetAgent'])]],
          granted: {
            statement: [
              { effect: 'Allow', action: ['agents:GetAgent'] },
              { effect: 'Deny', action: ['*'] },
            ],
          },
        })
      ).toEqual([]);
    });
  });
});
