import { renameSrnPrefix } from '../../../../scripts/renameSrnPrefixTransforms';

/**
 * The pure half of the one-shot `soat:` → `srn:` resource-name migration
 * (`scripts/renameSrnPrefix.ts`). It rewrites stored policy documents in place,
 * and a policy that stops matching fails closed *silently* — an over-eager or
 * incomplete rewrite shows up as unexplained 403s, not as an error. Every case
 * below is a shape that really occurs in the columns it touches.
 */
describe('renameSrnPrefix', () => {
  test('rewrites a resource SRN in a policy statement', () => {
    expect(
      renameSrnPrefix({
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            resource: ['soat:proj_abc:file:*'],
          },
        ],
      })
    ).toEqual({
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: ['srn:proj_abc:file:*'],
        },
      ],
    });
  });

  test('rewrites every wildcard form', () => {
    expect(
      renameSrnPrefix([
        'soat:*:*:*',
        'soat:proj_abc:*:*',
        'soat:proj_abc:secret:sec_1',
      ])
    ).toEqual(['srn:*:*:*', 'srn:proj_abc:*:*', 'srn:proj_abc:secret:sec_1']);
  });

  test('leaves condition keys untouched — they are not resource names', () => {
    // `soat:ResourceTag/<key>` keeps its prefix in this change. It is an object
    // key, and it has two segments rather than an SRN's four, so neither the
    // value-only walk nor the shape check can reach it.
    expect(
      renameSrnPrefix({
        condition: {
          StringEquals: {
            'soat:ResourceTag/env': 'prod',
            'soat:ResourceType': 'file',
          },
        },
      })
    ).toEqual({
      condition: {
        StringEquals: {
          'soat:ResourceTag/env': 'prod',
          'soat:ResourceType': 'file',
        },
      },
    });
  });

  test('leaves a bare * resource untouched', () => {
    expect(renameSrnPrefix({ resource: ['*'] })).toEqual({ resource: ['*'] });
  });

  test('leaves a malformed soat: string that is not an SRN untouched', () => {
    // Too few segments to be an SRN — rewriting it would invent a shape the
    // validator never accepted in the first place.
    expect(renameSrnPrefix(['soat:proj_abc', 'soat:proj_abc:file'])).toEqual([
      'soat:proj_abc',
      'soat:proj_abc:file',
    ]);
  });

  test('rewrites a boundary policy nested in an agent version snapshot', () => {
    expect(
      renameSrnPrefix({
        name: 'writer',
        boundary_policy: {
          statement: [
            { effect: 'Allow', resource: ['soat:proj_abc:document:doc_1'] },
          ],
        },
      })
    ).toEqual({
      name: 'writer',
      boundary_policy: {
        statement: [
          { effect: 'Allow', resource: ['srn:proj_abc:document:doc_1'] },
        ],
      },
    });
  });

  test('leaves the guardrail runtime namespace untouched', () => {
    // `runtime.*` uses dots, `srn:` uses colons — but both live in formation
    // templates, so prove the walk does not confuse them.
    expect(renameSrnPrefix({ var: 'runtime.usage.cost_usd_24h' })).toEqual({
      var: 'runtime.usage.cost_usd_24h',
    });
  });

  test('is idempotent', () => {
    const once = renameSrnPrefix({ resource: ['soat:proj_abc:file:*'] });
    expect(renameSrnPrefix(once)).toEqual(once);
  });
});
