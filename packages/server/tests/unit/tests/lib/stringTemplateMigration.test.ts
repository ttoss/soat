import {
  migrateBodyRefs,
  migrateDiscussionString,
  migrateFormationTemplate,
  migratePathParams,
  migrateSecretRefs,
  migrateSubString,
  migrateToolExecute,
  migrateToolMcp,
  migrateToolUrl,
} from '../../../../scripts/stringTemplateTransforms';

describe('stringTemplateTransforms', () => {
  describe('atomic rules', () => {
    test('migrateSecretRefs rewrites a literal secret token', () => {
      expect(migrateSecretRefs('Bearer {{secret:sec_01}}')).toBe(
        'Bearer ${secret.sec_01}'
      );
    });

    test('migrateBodyRefs rewrites a body token', () => {
      expect(migrateBodyRefs('/x/${body.itemId}')).toBe('/x/${arg.itemId}');
    });

    test('migratePathParams rewrites a single-brace param', () => {
      expect(migratePathParams('/x/{itemId}')).toBe('/x/${arg.itemId}');
    });

    test('migrateDiscussionString rewrites topic/steps/transcript', () => {
      expect(
        migrateDiscussionString('t={topic} s={steps.a.last} x={transcript}')
      ).toBe('t=${topic} s=${steps.a.last} x=${transcript}');
    });
  });

  describe('migrateToolUrl (ordered composition)', () => {
    test('rewrites path params, body refs, and secrets in one URL', () => {
      expect(
        migrateToolUrl('https://x/{id}?key={{secret:sec_9}}&q=${body.q}')
      ).toBe('https://x/${arg.id}?key=${secret.sec_9}&q=${arg.q}');
    });

    test('is idempotent (second run is a no-op)', () => {
      const once = migrateToolUrl('https://x/{id}?q=${body.q}');
      expect(migrateToolUrl(once)).toBe(once);
    });
  });

  describe('migrateToolExecute / migrateToolMcp', () => {
    test('migrates execute url and header secret refs', () => {
      expect(
        migrateToolExecute({
          url: 'https://x/{id}',
          method: 'GET',
          headers: { Authorization: 'Bearer {{secret:sec_1}}' },
        })
      ).toEqual({
        url: 'https://x/${arg.id}',
        method: 'GET',
        headers: { Authorization: 'Bearer ${secret.sec_1}' },
      });
    });

    test('migrates mcp url and headers as secrets only (no path params)', () => {
      expect(
        migrateToolMcp({
          url: 'https://mcp/{keep}?k={{secret:sec_2}}',
          headers: { Authorization: '{{secret:sec_2}}' },
        })
      ).toEqual({
        // mcp urls were never arg-interpolated, so {keep} stays literal
        url: 'https://mcp/{keep}?k=${secret.sec_2}',
        headers: { Authorization: '${secret.sec_2}' },
      });
    });
  });

  describe('migrateSubString (formation, context-aware)', () => {
    const resourceKeys = new Set(['MySecret']);
    const paramKeys = new Set(['stage']);

    test('classifies a resource id as a ref and a param as a param', () => {
      expect(
        migrateSubString({
          sub: '${stage}-${MySecret}',
          resourceKeys,
          paramKeys,
        })
      ).toBe('${param.stage}-${ref.MySecret}');
    });

    test('rewrites body tokens to arg', () => {
      expect(
        migrateSubString({ sub: '${body.name}', resourceKeys, paramKeys })
      ).toBe('${arg.name}');
    });

    test('composes a resource ref inside a secret wrapper', () => {
      expect(
        migrateSubString({
          sub: 'Bearer {{secret:${MySecret}}}',
          resourceKeys,
          paramKeys,
        })
      ).toBe('Bearer ${secret.${ref.MySecret}}');
    });

    test('defaults an unknown token to a param', () => {
      expect(
        migrateSubString({ sub: '${Unknown}', resourceKeys, paramKeys })
      ).toBe('${param.Unknown}');
    });

    test('is idempotent', () => {
      const once = migrateSubString({
        sub: 'Bearer {{secret:${MySecret}}}',
        resourceKeys,
        paramKeys,
      });
      expect(migrateSubString({ sub: once, resourceKeys, paramKeys })).toBe(
        once
      );
    });
  });

  describe('migrateFormationTemplate', () => {
    const template = {
      parameters: { AppUrl: { type: 'string' } },
      resources: {
        MySecret: { type: 'secret', properties: { name: 's', value: 'v' } },
        MyTool: {
          type: 'tool',
          properties: {
            name: 'my-tool',
            execute: {
              url: { sub: '${AppUrl}/x/${body.id}' },
              headers: {
                Authorization: { sub: 'Bearer {{secret:${MySecret}}}' },
              },
            },
          },
        },
      },
    };

    test('rewrites param, arg, ref, and secret tokens by context', () => {
      const migrated = migrateFormationTemplate(template) as typeof template;
      const props = migrated.resources.MyTool.properties as {
        execute: {
          url: { sub: string };
          headers: { Authorization: { sub: string } };
        };
      };
      expect(props.execute.url.sub).toBe('${param.AppUrl}/x/${arg.id}');
      expect(props.execute.headers.Authorization.sub).toBe(
        'Bearer ${secret.${ref.MySecret}}'
      );
    });

    test('is idempotent', () => {
      const once = migrateFormationTemplate(template);
      expect(migrateFormationTemplate(once)).toEqual(once);
    });
  });
});
