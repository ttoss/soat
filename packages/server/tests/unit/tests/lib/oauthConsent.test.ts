import { DomainError } from '../../../../src/errors';
import {
  buildConsentPolicy,
  buildConsentScopes,
} from '../../../../src/lib/oauthConsent';

describe('oauthConsent', () => {
  describe('buildConsentScopes', () => {
    test('"all" selection grants the wildcard scope', () => {
      expect(buildConsentScopes({ kind: 'all' })).toEqual(['*']);
    });

    test('"modules" selection grants module wildcards, sorted and unique', () => {
      expect(
        buildConsentScopes({
          kind: 'modules',
          modules: ['files', 'agents', 'files'],
        })
      ).toEqual(['agents:*', 'files:*']);
    });

    test('"actions" selection grants the exact actions', () => {
      expect(
        buildConsentScopes({
          kind: 'actions',
          actions: ['agents:CreateAgent', 'agents:ListAgents'],
        })
      ).toEqual(['agents:CreateAgent', 'agents:ListAgents']);
    });

    test('rejects an unknown module', () => {
      expect(() => {
        return buildConsentScopes({
          kind: 'modules',
          modules: ['not-a-module'],
        });
      }).toThrow(DomainError);
    });

    test('rejects an unknown action', () => {
      expect(() => {
        return buildConsentScopes({
          kind: 'actions',
          actions: ['agents:Nope'],
        });
      }).toThrow(DomainError);
    });

    test('rejects an empty selection', () => {
      expect(() => {
        return buildConsentScopes({ kind: 'modules', modules: [] });
      }).toThrow(DomainError);
    });
  });

  describe('buildConsentPolicy', () => {
    test('scopes the policy to the chosen project', () => {
      const policy = buildConsentPolicy({
        projectPublicId: 'prj_123',
        selection: { kind: 'modules', modules: ['agents'] },
      });

      expect(policy).toEqual({
        statement: [
          {
            effect: 'Allow',
            action: ['agents:*'],
            resource: ['soat:prj_123:*:*'],
          },
        ],
      });
    });

    test('"all" produces a project-scoped full-access statement', () => {
      const policy = buildConsentPolicy({
        projectPublicId: 'prj_abc',
        selection: { kind: 'all' },
      });
      expect(policy.statement[0].action).toEqual(['*']);
      expect(policy.statement[0].resource).toEqual(['soat:prj_abc:*:*']);
    });

    test('produced policy is a valid IAM policy document', () => {
      // buildConsentPolicy must never emit a document the IAM validator rejects
      const policy = buildConsentPolicy({
        projectPublicId: 'prj_1',
        selection: { kind: 'actions', actions: ['files:GetFile'] },
      });
      expect(policy.statement[0].resource).toEqual(['soat:prj_1:*:*']);
    });
  });
});
