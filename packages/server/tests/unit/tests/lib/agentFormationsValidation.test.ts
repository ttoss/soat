/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  parseFormationTemplateInput,
  validateFormationTemplate,
} from 'src/lib/agentFormationsValidation';

// ── parseFormationTemplateInput ────────────────────────────────────────────

describe('parseFormationTemplateInput', () => {
  test('returns non-string input unchanged (object)', () => {
    const obj = { resources: {} };
    expect(parseFormationTemplateInput(obj)).toBe(obj);
  });

  test('returns non-string input unchanged (null)', () => {
    expect(parseFormationTemplateInput(null)).toBeNull();
  });

  test('returns non-string input unchanged (number)', () => {
    expect(parseFormationTemplateInput(42)).toBe(42);
  });

  test('returns non-string input unchanged (array)', () => {
    const arr = [1, 2, 3];
    expect(parseFormationTemplateInput(arr)).toBe(arr);
  });

  test('parses a valid YAML string into an object', () => {
    const yaml = [
      'resources:',
      '  MyMemory:',
      '    type: memory',
      '    properties:',
      '      name: Test',
    ].join('\n');

    const result = parseFormationTemplateInput(yaml);
    expect(result).toEqual({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'Test' } },
      },
    });
  });

  test('parses a valid JSON string into an object', () => {
    const json = JSON.stringify({
      resources: { R: { type: 'memory', properties: { name: 'json-test' } } },
    });
    const result = parseFormationTemplateInput(json) as any;
    expect(result.resources.R.type).toBe('memory');
  });

  test('returns raw string when YAML parse fails', () => {
    // An unclosed flow-sequence causes js-yaml to throw a YAMLException
    const invalidYaml = 'key: [unclosed';
    const result = parseFormationTemplateInput(invalidYaml);
    expect(result).toBe(invalidYaml);
  });
});

// ── validateFormationTemplate ──────────────────────────────────────────────

describe('validateFormationTemplate', () => {
  // ── Top-level shape ────────────────────────────────────────────────────

  test('returns invalid for null template', () => {
    const result = validateFormationTemplate(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('');
    expect(result.errors[0].message).toContain('object');
  });

  test('returns invalid for array template', () => {
    const result = validateFormationTemplate([1, 2, 3]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('');
  });

  test('returns invalid for string template', () => {
    const result = validateFormationTemplate('not-an-object');
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('');
  });

  test('returns invalid when resources key is missing', () => {
    const result = validateFormationTemplate({});
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('resources');
  });

  test('returns invalid when resources is null', () => {
    const result = validateFormationTemplate({ resources: null });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('resources');
  });

  test('returns invalid when resources is an array', () => {
    const result = validateFormationTemplate({ resources: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('resources');
  });

  // ── Resource declaration ───────────────────────────────────────────────

  test('returns invalid when resource declaration is not an object', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: 'invalid' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('object');
  });

  test('returns invalid when resource declaration is null', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: null },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('object');
  });

  test('returns invalid when resource declaration is an array', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: [1, 2] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('object');
  });

  // ── Resource type ──────────────────────────────────────────────────────

  test('returns invalid when resource type is missing', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: { properties: {} } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.endsWith('.type');
      })
    ).toBe(true);
    expect(
      result.errors.some((e) => {
        return e.message.includes('required');
      })
    ).toBe(true);
  });

  test('returns invalid when resource type is not a string', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: { type: 42, properties: {} } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.endsWith('.type');
      })
    ).toBe(true);
  });

  test('returns invalid when resource type is unsupported', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: { type: 'unknown_type', properties: {} } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes('Unsupported');
      })
    ).toBe(true);
  });

  // ── Resource properties ────────────────────────────────────────────────

  test('returns invalid when properties is missing', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: { type: 'memory' } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.endsWith('.properties');
      })
    ).toBe(true);
  });

  test('returns invalid when properties is null', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: { type: 'memory', properties: null } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.endsWith('.properties');
      })
    ).toBe(true);
  });

  test('returns invalid when properties is an array', () => {
    const result = validateFormationTemplate({
      resources: { MyResource: { type: 'memory', properties: [] } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.endsWith('.properties');
      })
    ).toBe(true);
  });

  test('returns invalid when properties contain unknown ref', () => {
    const result = validateFormationTemplate({
      resources: {
        MyAgent: {
          type: 'agent',
          properties: { ai_provider_id: { ref: 'NonExistent' } },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes("'NonExistent'");
      })
    ).toBe(true);
  });

  // ── depends_on ─────────────────────────────────────────────────────────

  test('returns invalid when depends_on is not an array', () => {
    const result = validateFormationTemplate({
      resources: {
        MyResource: {
          type: 'memory',
          properties: { name: 'test' },
          depends_on: 'not-an-array',
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes('array');
      })
    ).toBe(true);
  });

  test('returns invalid when depends_on entry is not a string', () => {
    const result = validateFormationTemplate({
      resources: {
        MyResource: {
          type: 'memory',
          properties: { name: 'test' },
          depends_on: [42],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes('string');
      })
    ).toBe(true);
  });

  test('returns invalid when depends_on references an unknown resource', () => {
    const result = validateFormationTemplate({
      resources: {
        MyResource: {
          type: 'memory',
          properties: { name: 'test' },
          depends_on: ['NonExistent'],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes("'NonExistent'");
      })
    ).toBe(true);
  });

  test('accepts valid depends_on referencing an existing resource', () => {
    const result = validateFormationTemplate({
      resources: {
        Provider: { type: 'ai_provider', properties: { name: 'gpt4' } },
        MyAgent: {
          type: 'agent',
          properties: { name: 'bot', ai_provider_id: { ref: 'Provider' } },
          depends_on: ['Provider'],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ── outputs ────────────────────────────────────────────────────────────

  test('returns invalid when outputs reference an unknown resource', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      outputs: { badRef: { ref: 'NonExistent' } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.startsWith('outputs');
      })
    ).toBe(true);
  });

  test('skips outputs validation when outputs is not a plain object', () => {
    // outputs as array → getOutputsObject returns null → no output errors
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      outputs: ['bad'],
    });
    expect(result.valid).toBe(true);
  });

  // ── circular dependency ────────────────────────────────────────────────

  test('returns invalid when resources have a circular dependency', () => {
    const result = validateFormationTemplate({
      resources: {
        A: { type: 'memory', properties: {}, depends_on: ['B'] },
        B: { type: 'memory', properties: {}, depends_on: ['A'] },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes('Circular');
      })
    ).toBe(true);
  });

  // ── valid template ─────────────────────────────────────────────────────

  test('returns valid for a well-formed template with outputs', () => {
    const result = validateFormationTemplate({
      resources: {
        MyProvider: {
          type: 'ai_provider',
          properties: { name: 'openai', model: 'gpt-4o' },
        },
        MyMemory: {
          type: 'memory',
          properties: { name: 'context-memory' },
        },
        MyAgent: {
          type: 'agent',
          properties: {
            name: 'assistant',
            ai_provider_id: { ref: 'MyProvider' },
          },
          depends_on: ['MyProvider'],
        },
      },
      outputs: {
        providerId: { ref: 'MyProvider' },
        memoryId: { ref: 'MyMemory' },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns valid for a minimal template with no outputs', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'minimal' } },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
