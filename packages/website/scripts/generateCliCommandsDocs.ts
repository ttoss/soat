/* eslint-disable complexity */
/* eslint-disable max-lines */
/**
 * Generates packages/website/docs/cli/commands.md from OpenAPI YAML specs.
 * Run with: pnpm tsx scripts/generateCliCommandsDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { load } from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const CLI_DOCS_DIR = path.resolve(__dirname, '../docs/cli');
const INDEX_OUTPUT_FILE = path.resolve(CLI_DOCS_DIR, 'commands.md');
const MODULES_OUTPUT_DIR = path.resolve(CLI_DOCS_DIR, 'commands');

interface OpenApiSpec {
  tags?: Array<{ name: string }>;
  paths?: Record<string, Record<string, OperationSpec>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
}

interface OperationSpec {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterSpec[];
  requestBody?: RequestBodySpec;
}

interface ParameterSpec {
  name: string;
  in: 'path' | 'query' | string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
}

interface RequestBodySpec {
  required?: boolean;
  content?: Record<
    string,
    {
      schema?: JsonSchema;
    }
  >;
}

interface JsonSchema {
  $ref?: string;
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  nullable?: boolean;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  items?: JsonSchema;
}

interface CommandFlag {
  flag: string;
  source: 'path' | 'query' | 'body' | 'wrapper';
  required: boolean;
  type: string;
  description: string;
  defaultValue?: string;
  example?: string;
  notes?: string;
}

interface CommandEntry {
  command: string;
  operationId: string;
  httpMethod: string;
  apiPath: string;
  flags: CommandFlag[];
  description: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const toKebab = (s: string): string => {
  return s
    .replace(/([A-Z])/g, (m) => {
      return `-${m.toLowerCase()}`;
    })
    .replace(/^-/, '');
};

const toFlag = (s: string): string => {
  return `--${toKebab(s.replace(/_/g, '-'))}`;
};

const toTitleCase = (kebab: string): string => {
  return kebab
    .split('-')
    .map((w) => {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
};

/**
 * Map spec filenames to a different module doc page when the spec belongs to
 * a sub-resource whose documentation lives inside a parent module's page.
 */
const DOC_OVERRIDES: Record<string, string> = {
  memoryEntries: 'memories',
};

const WRAPPER_FLAG_OVERRIDES: Record<string, CommandFlag[]> = {
  'validate-formation': [
    {
      flag: '--template-path',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Read template from a local JSON/YAML file and map it to body.template.',
      notes: 'Mutually exclusive with --template and --template-file.',
    },
    {
      flag: '--template-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description: 'Alias of --template-path.',
      notes: 'Mutually exclusive with --template and --template-path.',
    },
  ],
  'plan-formation': [
    {
      flag: '--template-path',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Read template from a local JSON/YAML file and map it to body.template.',
      notes: 'Mutually exclusive with --template and --template-file.',
    },
    {
      flag: '--template-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description: 'Alias of --template-path.',
      notes: 'Mutually exclusive with --template and --template-path.',
    },
    {
      flag: '--parameter',
      source: 'wrapper',
      required: false,
      type: 'string (repeatable key=value or key)',
      description:
        'Repeatable parameter assignment merged into body.parameters. Values support $VAR, ${VAR}, or @VAR_NAME (shell-safe env-file reference). Omit the value (--parameter KEY) to auto-read KEY from the merged env.',
      notes: 'Mutually exclusive with --parameters.',
    },
    {
      flag: '--env-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Load environment variables from file for resolving $VAR, ${VAR}, and @VAR_NAME in --parameter values.',
    },
  ],
  'create-formation': [
    {
      flag: '--template-path',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Read template from a local JSON/YAML file and map it to body.template.',
      notes: 'Mutually exclusive with --template and --template-file.',
    },
    {
      flag: '--template-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description: 'Alias of --template-path.',
      notes: 'Mutually exclusive with --template and --template-path.',
    },
    {
      flag: '--parameter',
      source: 'wrapper',
      required: false,
      type: 'string (repeatable key=value or key)',
      description:
        'Repeatable parameter assignment merged into body.parameters. Values support $VAR, ${VAR}, or @VAR_NAME (shell-safe env-file reference). Omit the value (--parameter KEY) to auto-read KEY from the merged env.',
      notes: 'Mutually exclusive with --parameters.',
    },
    {
      flag: '--env-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Load environment variables from file for resolving $VAR, ${VAR}, and @VAR_NAME in --parameter values.',
    },
  ],
  'update-formation': [
    {
      flag: '--template-path',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Read template from a local JSON/YAML file and map it to body.template.',
      notes: 'Mutually exclusive with --template and --template-file.',
    },
    {
      flag: '--template-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description: 'Alias of --template-path.',
      notes: 'Mutually exclusive with --template and --template-path.',
    },
    {
      flag: '--parameter',
      source: 'wrapper',
      required: false,
      type: 'string (repeatable key=value or key)',
      description:
        'Repeatable parameter assignment merged into body.parameters. Values support $VAR, ${VAR}, or @VAR_NAME (shell-safe env-file reference). Omit the value (--parameter KEY) to auto-read KEY from the merged env.',
      notes: 'Mutually exclusive with --parameters.',
    },
    {
      flag: '--env-file',
      source: 'wrapper',
      required: false,
      type: 'string',
      description:
        'Load environment variables from file for resolving $VAR, ${VAR}, and @VAR_NAME in --parameter values.',
    },
  ],
};

interface ModuleConfig {
  file: string;
  label: string;
  docFile: string;
  spec: OpenApiSpec;
}

const loadModules = (): ModuleConfig[] => {
  return fs
    .readdirSync(SPECS_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort()
    .map((f) => {
      const file = f.replace(/\.yaml$/, '');
      const spec = load(
        fs.readFileSync(path.join(SPECS_DIR, f), 'utf-8')
      ) as OpenApiSpec;
      const label = spec.tags?.[0]?.name ?? toTitleCase(file);
      const docFile = DOC_OVERRIDES[file] ?? file;
      return { file, label, docFile, spec };
    });
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const resolveSchemaRef = (args: {
  schema: JsonSchema;
  spec: OpenApiSpec;
}): JsonSchema => {
  const { schema, spec } = args;

  if (!schema.$ref) return schema;
  if (!schema.$ref.startsWith('#/components/schemas/')) return schema;

  const name = schema.$ref.replace('#/components/schemas/', '');
  const resolved = spec.components?.schemas?.[name];
  if (!resolved) return schema;

  return resolved;
};

const getSchemaTypeLabel = (args: {
  schema?: JsonSchema;
  spec: OpenApiSpec;
}): string => {
  const { schema, spec } = args;
  if (!schema) return 'unknown';

  const resolved = resolveSchemaRef({ schema, spec });

  if (resolved.enum && resolved.enum.length > 0) {
    return `enum(${resolved.enum
      .map((v) => {
        return JSON.stringify(v);
      })
      .join(', ')})`;
  }

  if (resolved.oneOf && resolved.oneOf.length > 0) {
    return resolved.oneOf
      .map((item) => {
        return getSchemaTypeLabel({ schema: item, spec });
      })
      .join(' | ');
  }

  if (resolved.anyOf && resolved.anyOf.length > 0) {
    return resolved.anyOf
      .map((item) => {
        return getSchemaTypeLabel({ schema: item, spec });
      })
      .join(' | ');
  }

  if (resolved.allOf && resolved.allOf.length > 0) {
    return resolved.allOf
      .map((item) => {
        return getSchemaTypeLabel({ schema: item, spec });
      })
      .join(' & ');
  }

  if (resolved.type === 'array') {
    const itemType = getSchemaTypeLabel({ schema: resolved.items, spec });
    return `array<${itemType}>`;
  }

  if (resolved.type === 'object') {
    if (isObject(resolved.additionalProperties)) {
      const valueType = getSchemaTypeLabel({
        schema: resolved.additionalProperties as JsonSchema,
        spec,
      });
      return `object<string, ${valueType}>`;
    }
    if (resolved.additionalProperties === true) {
      return 'object<string, unknown>';
    }
    return 'object';
  }

  const typeLabel = resolved.type ?? 'unknown';
  return resolved.nullable ? `${typeLabel} | null` : typeLabel;
};

const stringifyValue = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const toFlagFromName = (name: string): string => {
  return toFlag(name);
};

const getBodySchema = (args: {
  operation: OperationSpec;
  spec: OpenApiSpec;
}): JsonSchema | undefined => {
  const { operation, spec } = args;

  const content = operation.requestBody?.content;
  if (!content) return undefined;

  const schema =
    content['application/json']?.schema ??
    Object.values(content)[0]?.schema ??
    undefined;
  if (!schema) return undefined;

  return resolveSchemaRef({ schema, spec });
};

const getBodyFlags = (args: {
  operation: OperationSpec;
  spec: OpenApiSpec;
}): CommandFlag[] => {
  const { operation, spec } = args;
  const bodySchema = getBodySchema({ operation, spec });
  if (!bodySchema) return [];

  const bodyRequired = new Set(bodySchema.required ?? []);
  const properties = bodySchema.properties ?? {};

  return Object.entries(properties).map(([name, schema]) => {
    const resolved = resolveSchemaRef({ schema, spec });
    return {
      flag: toFlagFromName(name),
      source: 'body',
      required: Boolean(bodyRequired.has(name)),
      type: getSchemaTypeLabel({ schema: resolved, spec }),
      description: resolved.description ?? '—',
      defaultValue: stringifyValue(resolved.default),
      example: stringifyValue(resolved.example),
    };
  });
};

const getParamFlags = (args: {
  operation: OperationSpec;
  spec: OpenApiSpec;
}): CommandFlag[] => {
  const { operation, spec } = args;
  const params = operation.parameters ?? [];

  return params
    .filter((param) => {
      return param.in === 'path' || param.in === 'query';
    })
    .map((param) => {
      return {
        flag: toFlagFromName(param.name),
        source: param.in as 'path' | 'query',
        required: Boolean(param.required),
        type: getSchemaTypeLabel({ schema: param.schema, spec }),
        description: param.description ?? '—',
        defaultValue: stringifyValue(param.schema?.default),
        example: stringifyValue(param.example ?? param.schema?.example),
      };
    });
};

const getCommandFlags = (args: {
  command: string;
  operation: OperationSpec;
  spec: OpenApiSpec;
}): CommandFlag[] => {
  const { command, operation, spec } = args;

  const pathFlags = getParamFlags({ operation, spec }).filter((flag) => {
    return flag.source === 'path';
  });
  const queryFlags = getParamFlags({ operation, spec }).filter((flag) => {
    return flag.source === 'query';
  });
  const bodyFlags = getBodyFlags({ operation, spec });
  const wrapperFlags = WRAPPER_FLAG_OVERRIDES[command] ?? [];

  return [...pathFlags, ...queryFlags, ...bodyFlags, ...wrapperFlags];
};

const loadCommands = (args: {
  moduleName: string;
  spec: OpenApiSpec;
}): CommandEntry[] => {
  const { moduleName, spec } = args;
  const specPath = path.join(SPECS_DIR, `${moduleName}.yaml`);
  if (!fs.existsSync(specPath)) return [];
  const commands: CommandEntry[] = [];

  for (const [apiPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation.operationId) continue;

      const command = toKebab(operation.operationId);

      commands.push({
        command,
        operationId: operation.operationId,
        httpMethod: method.toUpperCase(),
        apiPath,
        flags: getCommandFlags({ command, operation, spec }),
        description: operation.summary ?? operation.description ?? '',
      });
    }
  }

  return commands;
};

const sanitizeCell = (text: string): string => {
  return text
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
};

const renderOption = (flag: CommandFlag): string => {
  const lines: string[] = [];

  lines.push(`##### \`${flag.flag}\``);
  lines.push('');
  lines.push(`${sanitizeCell(flag.description || 'No description provided.')}`);
  lines.push('');
  lines.push(`- Source: \`${flag.source}\``);
  lines.push(`- Required: ${flag.required ? 'yes' : 'no'}`);
  lines.push(`- Type: \`${sanitizeCell(flag.type)}\``);

  if (flag.defaultValue) {
    lines.push(`- Default: \`${sanitizeCell(flag.defaultValue)}\``);
  }

  if (flag.example) {
    lines.push(`- Example: \`${sanitizeCell(flag.example)}\``);
  }

  if (flag.notes) {
    lines.push(`- Notes: ${sanitizeCell(flag.notes)}`);
  }

  return lines.join('\n');
};

const renderUsage = (command: CommandEntry): string => {
  const requiredFlags = command.flags
    .filter((flag) => {
      return flag.required;
    })
    .map((flag) => {
      return `${flag.flag} <${flag.type}>`;
    });

  const suffix = requiredFlags.length > 0 ? ` ${requiredFlags.join(' ')}` : '';
  return `soat ${command.command}${suffix}`;
};

const renderCommandSection = (command: CommandEntry): string => {
  const description = sanitizeCell(command.description || '—');
  const options = command.flags;

  const lines = [
    `### \`soat ${command.command}\``,
    '',
    `${description}`,
    '',
    `- Method: \`${command.httpMethod}\``,
    `- Path: \`${command.apiPath}\``,
    '',
    '#### Usage',
    '',
    '```bash',
    renderUsage(command),
    '```',
    '',
    '#### Options',
    '',
  ];

  if (options.length === 0) {
    lines.push('This command has no options.');
    return lines.join('\n');
  }

  for (const option of options) {
    lines.push(renderOption(option));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
};

const toModuleDocFileName = (moduleName: string): string => {
  return `${toKebab(moduleName)}.md`;
};

const writeModuleDocs = (args: {
  moduleLabel: string;
  moduleDocFile: string;
  outputFile: string;
  commands: CommandEntry[];
}) => {
  const { moduleLabel, moduleDocFile, outputFile, commands } = args;

  const sections: string[] = [
    '---',
    `title: ${moduleLabel} Commands`,
    '---',
    '',
    `# ${moduleLabel} Commands`,
    '',
    `See [${moduleLabel} module docs](../../modules/${moduleDocFile}) for permissions and data model.`,
  ];

  for (const command of commands) {
    sections.push('');
    sections.push(renderCommandSection(command));
  }

  sections.push('');
  fs.writeFileSync(outputFile, sections.join('\n'), 'utf-8');
};

const cleanGeneratedModuleDocs = () => {
  if (!fs.existsSync(MODULES_OUTPUT_DIR)) {
    fs.mkdirSync(MODULES_OUTPUT_DIR, { recursive: true });
    return;
  }

  const existingFiles = fs.readdirSync(MODULES_OUTPUT_DIR);
  for (const file of existingFiles) {
    if (!file.endsWith('.md')) continue;
    fs.unlinkSync(path.join(MODULES_OUTPUT_DIR, file));
  }
};

const main = () => {
  const modules = loadModules();
  cleanGeneratedModuleDocs();

  const generatedModuleLinks: string[] = [];

  for (const mod of modules) {
    const commands = loadCommands({ moduleName: mod.file, spec: mod.spec });
    if (commands.length === 0) continue;

    const moduleFileName = toModuleDocFileName(mod.file);
    const moduleOutputFile = path.join(MODULES_OUTPUT_DIR, moduleFileName);

    writeModuleDocs({
      moduleLabel: mod.label,
      moduleDocFile: mod.docFile,
      outputFile: moduleOutputFile,
      commands,
    });

    generatedModuleLinks.push(
      `- [${mod.label}](./commands/${moduleFileName.replace(/\.md$/, '')})`
    );
  }

  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Commands Reference',
    '',
    'Complete list of all CLI commands, grouped by module.',
    '',
    'Each module has its own command reference page with usage and option details derived from OpenAPI.',
    '',
    '## Special Commands',
    '',
    '### `soat configure`',
    '',
    'Add or update a profile in `~/.soat/config.json`.',
    '',
    '### `soat list-commands`',
    '',
    'Print all available API commands.',
    '',
    '### `soat listen`',
    '',
    'Start a local webhook listener for testing deliveries.',
    '',
    '#### Usage',
    '',
    '```bash',
    '# Basic webhook listener',
    'soat listen --port 8787 --path /webhook',
    '',
    '# Filter only session generation lifecycle events',
    'soat listen --port 8787 --path /webhook --filter sessions.generation.*',
    '',
    '# Verify webhook signatures and output JSON lines',
    'soat listen --port 8787 --path /webhook --secret "<webhook-secret>" --json',
    '```',
    '',
    '## Modules',
    '',
    ...generatedModuleLinks,
  ];

  sections.push('');

  fs.writeFileSync(INDEX_OUTPUT_FILE, sections.join('\n'), 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`CLI commands docs written to: ${INDEX_OUTPUT_FILE}`);
  // eslint-disable-next-line no-console
  console.log(`CLI module command docs written to: ${MODULES_OUTPUT_DIR}`);
};

main();
