import {
  isSensitiveAttribute,
  redactPlanChanges,
  redactSensitiveOutputs,
  redactTemplateSecrets,
  sensitiveOutputNames,
  SENSITIVE_PLACEHOLDER,
} from 'src/lib/formationsSensitive';
import type { FormationTemplate } from 'src/lib/formationsTypes';

const secretTemplate: FormationTemplate = {
  resources: {
    Key: {
      type: 'secret',
      properties: { name: 'api-key', value: 'sk-live-123' },
    },
    Mem: {
      type: 'memory',
      properties: { name: 'notes' },
    },
  },
};

describe('redactTemplateSecrets', () => {
  test('masks a write-only property declared as a literal', () => {
    const redacted = redactTemplateSecrets({ template: secretTemplate });
    expect(redacted.resources.Key.properties.value).toEqual(
      SENSITIVE_PLACEHOLDER
    );
  });

  test('leaves every other property alone', () => {
    const redacted = redactTemplateSecrets({ template: secretTemplate });
    expect(redacted.resources.Key.properties.name).toBe('api-key');
    expect(redacted.resources.Mem.properties).toEqual({ name: 'notes' });
  });

  test('does not mutate the template it was given', () => {
    redactTemplateSecrets({ template: secretTemplate });
    expect(secretTemplate.resources.Key.properties.value).toBe('sk-live-123');
  });

  test('masks an expression the same way, since it resolves to the value', () => {
    const redacted = redactTemplateSecrets({
      template: {
        resources: {
          Key: {
            type: 'secret',
            properties: { name: 'api-key', value: { param: 'ApiKey' } },
          },
        },
      },
    });
    expect(redacted.resources.Key.properties.value).toEqual(
      SENSITIVE_PLACEHOLDER
    );
  });

  test('leaves a resource type no module claims untouched', () => {
    const template: FormationTemplate = {
      resources: {
        X: { type: 'not_a_real_type', properties: { value: 'kept' } },
      },
    };
    expect(redactTemplateSecrets({ template }).resources.X.properties.value).toBe(
      'kept'
    );
  });

  test('tolerates a declaration with no properties bag', () => {
    const template = {
      resources: { Key: { type: 'secret' } },
    } as unknown as FormationTemplate;
    expect(() => {
      return redactTemplateSecrets({ template });
    }).not.toThrow();
  });

  test('returns a template with no resources unchanged', () => {
    const template = { resources: {} } as FormationTemplate;
    expect(redactTemplateSecrets({ template }).resources).toEqual({});
  });
});

describe('redactPlanChanges', () => {
  test('masks the write-only property on both sides of the diff', () => {
    const [change] = redactPlanChanges({
      changes: [
        {
          logicalId: 'Key',
          resourceType: 'secret',
          action: 'update',
          diff: {
            desired: { name: 'api-key', value: 'sk-new' },
            current: { name: 'api-key', value: 'sk-old' },
          },
        },
      ],
    });
    expect(change.diff?.desired.value).toEqual(SENSITIVE_PLACEHOLDER);
    expect(change.diff?.current?.value).toEqual(SENSITIVE_PLACEHOLDER);
    expect(change.diff?.desired.name).toBe('api-key');
  });

  test('leaves a change with no diff alone', () => {
    const [change] = redactPlanChanges({
      changes: [
        { logicalId: 'Key', resourceType: 'secret', action: 'delete' },
      ],
    });
    expect(change.diff).toBeUndefined();
  });

  test('leaves a null current side null', () => {
    const [change] = redactPlanChanges({
      changes: [
        {
          logicalId: 'Key',
          resourceType: 'secret',
          action: 'create',
          diff: { desired: { value: 'sk-new' }, current: null },
        },
      ],
    });
    expect(change.diff?.current).toBeNull();
  });
});

describe('isSensitiveAttribute', () => {
  test('a webhook signing secret is sensitive', () => {
    expect(
      isSensitiveAttribute({ resourceType: 'webhook', attrName: 'secret' })
    ).toBe(true);
  });

  test('a trigger signing secret is sensitive', () => {
    expect(
      isSensitiveAttribute({ resourceType: 'trigger', attrName: 'secret' })
    ).toBe(true);
  });

  test('another attribute of the same resource is not', () => {
    expect(
      isSensitiveAttribute({ resourceType: 'webhook', attrName: 'url' })
    ).toBe(false);
  });

  test('an unknown resource type is not', () => {
    expect(
      isSensitiveAttribute({ resourceType: 'not_a_real_type', attrName: 'secret' })
    ).toBe(false);
  });
});

describe('sensitiveOutputNames', () => {
  const template: FormationTemplate = {
    resources: {
      Hook: {
        type: 'webhook',
        properties: { name: 'h', url: 'https://e.example', events: ['*'] },
      },
      Mem: { type: 'memory', properties: { name: 'notes' } },
    },
    outputs: {
      hookSecret: { ref_attr: 'Hook.secret' },
      memoryId: { ref: 'Mem' },
      literal: 'plain',
    },
  };

  test('names only the outputs that resolve a sensitive attribute', () => {
    expect(sensitiveOutputNames({ template })).toEqual(['hookSecret']);
  });

  test('names none when the template declares no outputs', () => {
    expect(sensitiveOutputNames({ template: { resources: {} } })).toEqual([]);
  });

  test('skips a ref_attr naming a resource the template does not declare', () => {
    expect(
      sensitiveOutputNames({
        template: {
          resources: {},
          outputs: { x: { ref_attr: 'Nope.secret' } },
        },
      })
    ).toEqual([]);
  });

  test('skips a malformed ref_attr', () => {
    expect(
      sensitiveOutputNames({
        template: { resources: {}, outputs: { x: { ref_attr: 'nodot' } } },
      })
    ).toEqual([]);
  });

  test('redactSensitiveOutputs drops exactly those keys', () => {
    expect(
      redactSensitiveOutputs({
        template,
        outputs: { hookSecret: 'whsec_live', memoryId: 'mem_1' },
      })
    ).toEqual({ memoryId: 'mem_1' });
  });

  test('redactSensitiveOutputs returns null outputs unchanged', () => {
    expect(redactSensitiveOutputs({ template, outputs: null })).toBeNull();
  });
});
