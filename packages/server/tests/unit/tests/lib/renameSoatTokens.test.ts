import {
  renameNamespace,
  renameToolType,
} from '../../../../scripts/renameSoatTokensTransforms';

/**
 * The pure half of the one-shot `soat` → vendor-neutral data migration
 * (`scripts/renameSoatTokens.ts`). The transforms rewrite persisted JSONB in
 * place, so a wrong rewrite is unrecoverable once the script has run — every
 * case below is a shape that really occurs in the columns it touches.
 */
describe('renameNamespace (guardrail context namespace)', () => {
  test('rewrites a catalog var path inside a JSON Logic guard', () => {
    expect(
      renameNamespace({
        class: 'B',
        guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
      })
    ).toEqual({
      class: 'B',
      guard: { '<': [{ var: 'runtime.usage.cost_usd_24h' }, 1000] },
    });
  });

  test('rewrites every catalog root', () => {
    const roots = [
      'action',
      'tool.id',
      'agent.id',
      'project.id',
      'run.tool_calls',
      'activity.actions_24h',
      'usage.run_tokens',
    ];
    for (const root of roots) {
      expect(renameNamespace({ var: `soat.${root}` })).toEqual({
        var: `runtime.${root}`,
      });
    }
  });

  test('rewrites a path in the `[path, default]` var form', () => {
    expect(renameNamespace({ var: ['soat.usage.tokens_24h', 0] })).toEqual({
      var: ['runtime.usage.tokens_24h', 0],
    });
  });

  test('leaves object keys untouched — only string values are rewritten', () => {
    // A caller-authored `guardrail_context` bag may legitimately hold a key
    // that starts with `soat.`; rewriting it would corrupt the author's data.
    expect(
      renameNamespace({ context: { 'soat.usage.custom': 1 } })
    ).toEqual({ context: { 'soat.usage.custom': 1 } });
  });

  test('leaves an SRN and a condition key untouched', () => {
    // IAM keeps its branded prefix — `soat:` is not `soat.`.
    expect(
      renameNamespace({
        resource: ['soat:proj_abc:files:*'],
        condition: { StringEquals: { 'soat:ResourceTag/env': 'prod' } },
      })
    ).toEqual({
      resource: ['soat:proj_abc:files:*'],
      condition: { StringEquals: { 'soat:ResourceTag/env': 'prod' } },
    });
  });

  test('leaves a non-catalog soat-prefixed string untouched', () => {
    expect(renameNamespace({ var: 'soat.unknown.key' })).toEqual({
      var: 'soat.unknown.key',
    });
  });

  test('is idempotent', () => {
    const once = renameNamespace({ var: 'soat.usage.cost_usd_24h' });
    expect(renameNamespace(once)).toEqual(once);
  });
});

describe('renameToolType (tool type discriminator)', () => {
  test('rewrites a top-level tool type', () => {
    expect(renameToolType({ name: 'files', type: 'soat' })).toEqual({
      name: 'files',
      type: 'builtin',
    });
  });

  test('rewrites an inline pipeline step tool', () => {
    expect(
      renameToolType({
        steps: [{ id: 'a', tool: { name: 'inline', type: 'soat' } }],
      })
    ).toEqual({
      steps: [{ id: 'a', tool: { name: 'inline', type: 'builtin' } }],
    });
  });

  test('rewrites a tool resource nested in a formation template', () => {
    expect(
      renameToolType({
        resources: {
          Lister: { type: 'tool', properties: { type: 'soat' } },
        },
      })
    ).toEqual({
      resources: {
        Lister: { type: 'tool', properties: { type: 'builtin' } },
      },
    });
  });

  test('leaves every other tool type untouched', () => {
    for (const type of ['http', 'client', 'mcp', 'pipeline']) {
      expect(renameToolType({ type })).toEqual({ type });
    }
  });

  test('leaves a non-`type` key whose value is "soat" untouched', () => {
    expect(renameToolType({ provider: 'soat', name: 'soat' })).toEqual({
      provider: 'soat',
      name: 'soat',
    });
  });

  test('is idempotent', () => {
    const once = renameToolType({ type: 'soat' });
    expect(renameToolType(once)).toEqual(once);
  });
});
