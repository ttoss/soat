/**
 * Generates packages/website/docs/cli/commands.md from OpenAPI YAML specs.
 * Run with: pnpm tsx scripts/generateCliCommandsDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUTPUT_FILE = path.resolve(__dirname, '../docs/cli/commands.md');

interface OpenApiSpec {
  tags?: Array<{ name: string }>;
  paths?: Record<string, Record<string, OperationSpec>>;
}

interface OperationSpec {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
  }>;
  requestBody?: unknown;
}

interface CommandEntry {
  command: string;
  operationId: string;
  httpMethod: string;
  apiPath: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
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

const toTitleCase = (kebab: string): string => {
  return kebab
    .split('-')
    .map((w) => {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
};

interface ModuleConfig {
  file: string;
  label: string;
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
      const spec = yaml.load(
        fs.readFileSync(path.join(SPECS_DIR, f), 'utf-8')
      ) as OpenApiSpec;
      const label = spec.tags?.[0]?.name ?? toTitleCase(file);
      return { file, label };
    });
};

const loadCommands = (moduleName: string): CommandEntry[] => {
  const specPath = path.join(SPECS_DIR, `${moduleName}.yaml`);
  if (!fs.existsSync(specPath)) return [];

  const spec = yaml.load(fs.readFileSync(specPath, 'utf-8')) as OpenApiSpec;
  const commands: CommandEntry[] = [];

  for (const [apiPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation.operationId) continue;

      const params: Array<{ name: string; in: string }> =
        operation.parameters ?? [];
      const pathParams = params
        .filter((p) => {
          return p.in === 'path';
        })
        .map((p) => {
          return p.name;
        });
      const queryParams = params
        .filter((p) => {
          return p.in === 'query';
        })
        .map((p) => {
          return p.name;
        });

      commands.push({
        command: toKebab(operation.operationId),
        operationId: operation.operationId,
        httpMethod: method.toUpperCase(),
        apiPath,
        pathParams,
        queryParams,
        hasBody: method !== 'get' && method !== 'delete',
        description: operation.summary ?? operation.description ?? '',
      });
    }
  }

  return commands;
};

const renderTable = (commands: CommandEntry[]): string => {
  const header = [
    '| Command | HTTP | Path | Flags | Description |',
    '| ------- | ---- | ---- | ----- | ----------- |',
  ];
  const rows = commands.map((c) => {
    const allFlags = [
      ...c.pathParams.map((p) => {
        return `\`--${p}\``;
      }),
      ...c.queryParams.map((p) => {
        return `\`--${p}\``;
      }),
      ...(c.hasBody ? ['`--<body fields>`'] : []),
    ].join(', ');
    const desc = c.description.replace(/\n/g, ' ').replace(/\|/g, '\\|');
    return `| \`soat ${c.command}\` | \`${c.httpMethod}\` | \`/api/v1${c.apiPath}\` | ${allFlags || '—'} | ${desc} |`;
  });
  return [...header, ...rows].join('\n');
};

const main = () => {
  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Commands Reference',
    '',
    'Complete list of all CLI commands, grouped by module. Each command maps to one REST API operation.',
    '',
    ':::note',
    'This file is auto-generated. Run `pnpm generate-cli-commands-docs` to update it.',
    ':::',
    '',
    '## Special Commands',
    '',
    '| Command | Description |',
    '| ------- | ----------- |',
    '| `soat configure` | Add or update a profile in `~/.soat/config.json` |',
    '| `soat list-commands` | Print all available API commands |',
  ];

  for (const mod of loadModules()) {
    const commands = loadCommands(mod.file);
    if (commands.length === 0) continue;

    sections.push('');
    sections.push(`## ${mod.label}`);
    sections.push('');
    sections.push(
      `See [${mod.label} module docs](../modules/${mod.file}) for permissions and data model.`
    );
    sections.push('');
    sections.push(renderTable(commands));
  }

  sections.push('');

  fs.writeFileSync(OUTPUT_FILE, sections.join('\n'), 'utf-8');
  console.log(`CLI commands docs written to: ${OUTPUT_FILE}`);
};

main();
