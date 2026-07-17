/* eslint-disable @typescript-eslint/no-explicit-any */
import { getMissingParams } from 'src/lib/formationsHelpers';
import {
  parseFormationTemplateInput,
  validateFormationTemplate,
} from 'src/lib/formationsValidation';

// ── getMissingParams ───────────────────────────────────────────────────────

describe('getMissingParams', () => {
  const templateWithRequiredParams = {
    parameters: {
      ApiKey: { type: 'string' },
      ToolUrl: { type: 'string' },
    },
    resources: {
      ParamSecret: {
        type: 'secret',
        properties: { name: 'test', value: { param: 'ApiKey' } },
      },
      ParamMemory: {
        type: 'memory',
        properties: {
          name: { sub: '${ToolUrl}-memory' },
        },
      },
    },
  };

  test('returns empty array when all required params are provided', () => {
    const result = getMissingParams(templateWithRequiredParams, {
      ApiKey: 'secret-key',
      ToolUrl: 'https://api.example.com',
    });
    expect(result).toEqual([]);
  });

  test('returns missing param names when no params provided', () => {
    const result = getMissingParams(templateWithRequiredParams, undefined);
    expect(result).toContain('ApiKey');
    expect(result).toContain('ToolUrl');
  });

  test('returns param name when provided value is empty string', () => {
    const result = getMissingParams(templateWithRequiredParams, {
      ApiKey: '',
      ToolUrl: 'https://api.example.com',
    });
    expect(result).toContain('ApiKey');
    expect(result).not.toContain('ToolUrl');
  });

  test('returns all params when all provided values are empty strings', () => {
    const result = getMissingParams(templateWithRequiredParams, {
      ApiKey: '',
      ToolUrl: '',
    });
    expect(result).toContain('ApiKey');
    expect(result).toContain('ToolUrl');
  });

  test('returns empty array when param has a default and no override provided', () => {
    const templateWithDefault = {
      parameters: {
        MemName: { type: 'string', default: 'default-memory' },
      },
      resources: {
        Mem: {
          type: 'memory',
          properties: { name: { param: 'MemName' } },
        },
      },
    };
    const result = getMissingParams(templateWithDefault, undefined);
    expect(result).toEqual([]);
  });

  test('does not treat an empty-string default as missing', () => {
    const templateWithEmptyDefault = {
      parameters: {
        OptionalParam: { type: 'string', default: '' },
      },
      resources: {
        Mem: {
          type: 'memory',
          properties: { name: { param: 'OptionalParam' } },
        },
      },
    };
    const result = getMissingParams(templateWithEmptyDefault, undefined);
    expect(result).toEqual([]);
  });
});

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

  test('returns invalid when actor properties include unknown fields', () => {
    const result = validateFormationTemplate({
      resources: {
        MyActor: {
          type: 'actor',
          properties: {
            name: 'Actor 01',
            invalid_field: 'x',
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'resources.MyActor.properties.invalid_field';
      })
    ).toBe(true);
  });

  test('returns invalid when actor properties have wrong types', () => {
    const result = validateFormationTemplate({
      resources: {
        MyActor: {
          type: 'actor',
          properties: {
            name: 123,
            auto_create_memory: 'yes',
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'resources.MyActor.properties.name';
      })
    ).toBe(true);
    expect(
      result.errors.some((e) => {
        return e.path === 'resources.MyActor.properties.auto_create_memory';
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
        Provider: {
          type: 'ai_provider',
          properties: {
            name: 'gpt4',
            provider: 'openai',
            default_model: 'gpt-4o',
          },
        },
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

  // ── deletion_policy ────────────────────────────────────────────────────

  test('returns invalid when deletion_policy is an unsupported value', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: {
          type: 'memory',
          properties: { name: 'test' },
          deletion_policy: 'snapshot',
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.endsWith('.deletion_policy');
      })
    ).toBe(true);
  });

  test('accepts deletion_policy: delete', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: {
          type: 'memory',
          properties: { name: 'test' },
          deletion_policy: 'delete',
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('accepts deletion_policy: retain', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: {
          type: 'memory',
          properties: { name: 'test' },
          deletion_policy: 'retain',
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

  test('returns valid for a ref_attr output referencing a known resource', () => {
    const result = validateFormationTemplate({
      resources: {
        MyWebhook: {
          type: 'webhook',
          properties: {
            name: 'hook',
            url: 'https://example.com',
            events: ['*'],
          },
        },
      },
      outputs: { webhookSecret: { ref_attr: 'MyWebhook.secret' } },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns invalid when ref_attr references an unknown resource', () => {
    const result = validateFormationTemplate({
      resources: {
        MyWebhook: {
          type: 'webhook',
          properties: {
            name: 'hook',
            url: 'https://example.com',
            events: ['*'],
          },
        },
      },
      outputs: { webhookSecret: { ref_attr: 'NonExistent.secret' } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return (
          e.path.startsWith('outputs') && e.message.includes("'NonExistent'")
        );
      })
    ).toBe(true);
  });

  test('returns invalid when ref_attr has no dot separator', () => {
    const result = validateFormationTemplate({
      resources: {
        MyWebhook: {
          type: 'webhook',
          properties: {
            name: 'hook',
            url: 'https://example.com',
            events: ['*'],
          },
        },
      },
      outputs: { webhookSecret: { ref_attr: 'nodothere' } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path.startsWith('outputs') && e.message.includes('ref_attr');
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

  // ── metadata (F-16) ──────────────────────────────────────────────────────

  test('returns invalid when top-level metadata references an unknown resource', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      metadata: { ref: { ref: 'NonExistent' } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'metadata' && e.message.includes("'NonExistent'");
      })
    ).toBe(true);
  });

  test('returns invalid when metadata sub references an undeclared parameter', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      metadata: { version: { sub: '${undeclared}' } },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'metadata' && e.message.includes("'undeclared'");
      })
    ).toBe(true);
  });

  test('returns valid when metadata substitutes a declared param and a known resource', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      parameters: { version: { default: 'v1' } },
      metadata: {
        version: { sub: '${version}' },
        memory: { ref: 'MyMemory' },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('skips metadata validation when metadata is not a plain object', () => {
    const result = validateFormationTemplate({
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      metadata: ['bad'],
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
          properties: {
            name: 'openai',
            provider: 'openai',
            default_model: 'gpt-4o',
          },
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

  // ── parameters section ─────────────────────────────────────────────────

  test('returns invalid when parameters is not an object', () => {
    const result = validateFormationTemplate({
      parameters: 'not-an-object',
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'parameters';
      })
    ).toBe(true);
  });

  test('returns invalid when a parameter declaration is not an object', () => {
    const result = validateFormationTemplate({
      parameters: { MyParam: 'not-an-object' },
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'parameters.MyParam';
      })
    ).toBe(true);
  });

  test('returns invalid when parameter type field is not a string', () => {
    const result = validateFormationTemplate({
      parameters: { MyParam: { type: 42 } },
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'parameters.MyParam.type';
      })
    ).toBe(true);
  });

  test('returns invalid when param ref in resource properties is not in parameters', () => {
    const result = validateFormationTemplate({
      parameters: { AppUrl: { type: 'string' } },
      resources: {
        MyMemory: {
          type: 'memory',
          properties: {
            name: 'test',
            config: { param: 'UndeclaredParam' },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes("'UndeclaredParam'");
      })
    ).toBe(true);
  });

  test('returns invalid when sub ref in resource properties uses undeclared parameter', () => {
    const result = validateFormationTemplate({
      parameters: { AppUrl: { type: 'string' } },
      resources: {
        MyMemory: {
          type: 'memory',
          properties: {
            name: { sub: 'Bearer ${MissingKey}' },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes("'MissingKey'");
      })
    ).toBe(true);
  });

  test('returns invalid when param ref in outputs is not in parameters', () => {
    const result = validateFormationTemplate({
      parameters: {},
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
      outputs: {
        myOutput: { param: 'UndeclaredParam' },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return (
          e.path.startsWith('outputs') &&
          e.message.includes("'UndeclaredParam'")
        );
      })
    ).toBe(true);
  });

  test('warns about parameters without defaults', () => {
    const result = validateFormationTemplate({
      parameters: {
        RequiredParam: { type: 'string' },
        OptionalParam: { type: 'string', default: 'default-value' },
      },
      resources: {
        MyMemory: { type: 'memory', properties: { name: 'test' } },
      },
    });
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some((w) => {
        return (
          w.message.includes("'RequiredParam'") &&
          w.message.includes('must be provided')
        );
      })
    ).toBe(true);
    expect(
      result.warnings.every((w) => {
        return !w.message.includes("'OptionalParam'");
      })
    ).toBe(true);
  });

  test('returns valid for a template with parameters, param expression, and sub expression', () => {
    const result = validateFormationTemplate({
      parameters: {
        AppUrl: { type: 'string', default: 'https://example.com' },
        ApiKey: { type: 'string', no_echo: true },
      },
      resources: {
        MyTool: {
          type: 'tool',
          properties: {
            type: 'http',
            name: 'my-tool',
            execute: {
              url: { sub: '${AppUrl}/api/endpoint' },
              headers: { Authorization: { sub: 'Bearer ${ApiKey}' } },
            },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns valid when sub expression in HTTP tool URL uses body.xxx path interpolation', () => {
    const result = validateFormationTemplate({
      parameters: {
        AppUrl: { type: 'string', default: 'https://example.com' },
      },
      resources: {
        MyTool: {
          type: 'tool',
          properties: {
            type: 'http',
            name: 'patch-expense',
            execute: {
              url: {
                sub: '${AppUrl}/api/finance/recurring-expenses/${body.publicUuid}',
              },
              method: 'PATCH',
            },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns invalid when a pipeline tool step has an inline tool missing a name', () => {
    const result = validateFormationTemplate({
      resources: {
        MyPipeline: {
          type: 'tool',
          properties: {
            type: 'pipeline',
            name: 'my-pipeline',
            pipeline: {
              steps: [
                {
                  id: 'step1',
                  tool: { description: 'no name here' },
                },
              ],
            },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return (
          e.path === 'resources.MyPipeline.properties.pipeline' &&
          e.message.includes("step 'step1'") &&
          e.message.includes('inline tool must be an object with a name')
        );
      })
    ).toBe(true);
  });

  test('warns when a declared pipeline parameter is never referenced by any step', () => {
    const result = validateFormationTemplate({
      resources: {
        MyPipeline: {
          type: 'tool',
          properties: {
            type: 'pipeline',
            name: 'my-pipeline',
            parameters: {
              type: 'object',
              properties: { data: {}, strapiDocumentId: {} },
            },
            pipeline: {
              steps: [
                {
                  id: 'step1',
                  toolId: 'tool_x',
                  input: { body: { var: 'input.data' } },
                },
              ],
            },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some((w) => {
        return (
          w.path === 'resources.MyPipeline.properties.pipeline' &&
          w.message.includes("'strapiDocumentId'")
        );
      })
    ).toBe(true);
  });

  test('returns valid for a template with param expression in resource properties', () => {
    const result = validateFormationTemplate({
      parameters: {
        SecretId: { type: 'string' },
      },
      resources: {
        MyProvider: {
          type: 'ai_provider',
          properties: {
            name: 'xai',
            provider: 'xai',
            default_model: 'grok-1',
            secret_id: { param: 'SecretId' },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ── actorsFormationModule: non-object properties ───────────────────────

  test('returns invalid when actor resource properties is null', () => {
    const result = validateFormationTemplate({
      resources: {
        MyActor: {
          type: 'actor',
          properties: null,
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.message.includes('object');
      })
    ).toBe(true);
  });

  // ── formationSpecLoader: integer/number/array/object type validators ───

  test('returns invalid when agent max_steps is not an integer', () => {
    const result = validateFormationTemplate({
      resources: {
        MyAgent: {
          type: 'agent',
          properties: {
            ai_provider_id: 'aip_1',
            max_steps: 'five',
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'resources.MyAgent.properties.max_steps';
      })
    ).toBe(true);
  });

  test('returns invalid when agent temperature is not a number', () => {
    const result = validateFormationTemplate({
      resources: {
        MyAgent: {
          type: 'agent',
          properties: {
            ai_provider_id: 'aip_1',
            temperature: 'hot',
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'resources.MyAgent.properties.temperature';
      })
    ).toBe(true);
  });

  test('returns invalid when agent tool_ids is not an array', () => {
    const result = validateFormationTemplate({
      resources: {
        MyAgent: {
          type: 'agent',
          properties: {
            ai_provider_id: 'aip_1',
            tool_ids: 'tool1',
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => {
        return e.path === 'resources.MyAgent.properties.tool_ids';
      })
    ).toBe(true);
  });

  test('accepts string values for agent tool_choice', () => {
    for (const value of ['auto', 'required', 'none']) {
      const result = validateFormationTemplate({
        resources: {
          MyAgent: {
            type: 'agent',
            properties: {
              ai_provider_id: 'aip_1',
              tool_choice: value,
            },
          },
        },
      });
      expect(result.valid).toBe(true);
    }
  });

  test('accepts object values for agent tool_choice', () => {
    const result = validateFormationTemplate({
      resources: {
        MyAgent: {
          type: 'agent',
          properties: {
            ai_provider_id: 'aip_1',
            tool_choice: { type: 'tool', name: 'my_tool' },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  test('accepts null for agent tool_choice', () => {
    const result = validateFormationTemplate({
      resources: {
        MyAgent: {
          type: 'agent',
          properties: {
            ai_provider_id: 'aip_1',
            tool_choice: null,
          },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  // ── Schedule trigger cron parameterization ──────────────────────────────
  // A `schedule` trigger's cron may be supplied as an unresolved formation
  // expression; the "cron is required" shape rule must treat it as present
  // (its literal is validated at apply time, after the param/ref resolves).
  describe('schedule trigger cron via formation expression', () => {
    const scheduleTemplate = (cron: unknown): Record<string, unknown> => {
      return {
        parameters: {
          healthcheck_cron: { type: 'string', default: '0 11 * * *' },
        },
        resources: {
          MyOrch: {
            type: 'orchestration',
            properties: {
              name: 'o',
              nodes: [{ id: 'n', type: 'transform', expression: { var: '' } }],
              edges: [],
            },
          },
          MyTrigger: {
            type: 'trigger',
            properties: {
              name: 'hc',
              type: 'schedule',
              target_type: 'orchestration',
              target_id: { ref: 'MyOrch' },
              cron,
            },
          },
        },
      };
    };

    test('accepts a cron supplied via sub', () => {
      const result = validateFormationTemplate(
        scheduleTemplate({ sub: '${healthcheck_cron}' })
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('accepts a cron supplied via param', () => {
      const result = validateFormationTemplate(
        scheduleTemplate({ param: 'healthcheck_cron' })
      );
      expect(result.valid).toBe(true);
    });

    test('still accepts a literal cron', () => {
      const result = validateFormationTemplate(scheduleTemplate('0 11 * * *'));
      expect(result.valid).toBe(true);
    });

    test('still rejects a schedule trigger with no cron at all', () => {
      const result = validateFormationTemplate(scheduleTemplate(undefined));
      expect(result.valid).toBe(false);
      expect(
        result.errors.map((e) => {
          return e.message;
        })
      ).toContain('cron is required for schedule triggers.');
    });

    test('still rejects an invalid literal cron', () => {
      const result = validateFormationTemplate(scheduleTemplate('not a cron'));
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toMatch(/cron/i);
    });

    test('still rejects a cron (even parameterized) on a non-schedule trigger', () => {
      const result = validateFormationTemplate({
        parameters: { c: { type: 'string', default: '0 11 * * *' } },
        resources: {
          MyOrch: {
            type: 'orchestration',
            properties: {
              name: 'o',
              nodes: [{ id: 'n', type: 'transform', expression: { var: '' } }],
              edges: [],
            },
          },
          MyTrigger: {
            type: 'trigger',
            properties: {
              name: 't',
              type: 'manual',
              target_type: 'orchestration',
              target_id: { ref: 'MyOrch' },
              cron: { param: 'c' },
            },
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.map((e) => {
          return e.message;
        })
      ).toContain('cron is only valid for schedule triggers.');
    });
  });
});
