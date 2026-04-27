/**
 * Generates packages/website/docs/mcp/tools.md from OpenAPI YAML specs.
 * Run with: pnpm tsx scripts/generateMcpToolsDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');

const OUTPUT_FILE = path.resolve(__dirname, '../docs/mcp/tools.md');

interface OpenApiSpec {
  tags?: Array<{ name: string }>;
  paths?: Record<string, Record<string, OperationSpec>>;
}

interface OperationSpec {
  operationId?: string;
  description?: string;
}

interface ToolEntry {
  name: string;
  description: string;
}

const operationIdToToolName = (operationId: string): string => {
  return operationId
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
};

interface ModuleConfig {
  file: string;
  label: string;
  docLink: string;
}

const toTitleCase = (kebab: string): string => {
  return kebab
    .split('-')
    .map((w) => {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
};

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
      return { file, label, docLink: `../modules/${file}` };
    });
};

const loadTools = (moduleName: string): ToolEntry[] => {
  const specPath = path.join(SPECS_DIR, `${moduleName}.yaml`);
  if (!fs.existsSync(specPath)) return [];

  const spec = yaml.load(fs.readFileSync(specPath, 'utf-8')) as OpenApiSpec;
  const tools: ToolEntry[] = [];
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation.operationId) continue;
      tools.push({
        name: operationIdToToolName(operation.operationId),
        description: operation.description ?? '',
      });
    }
  }

  return tools;
};

const renderTable = (tools: ToolEntry[]): string => {
  const rows = tools.map((t) => {
    return `| \`${t.name}\` | ${t.description} |`;
  });
  return ['| Tool | Description |', '| ---- | ----------- |', ...rows].join(
    '\n'
  );
};

const main = () => {
  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Tools Reference',
    '',
    'Complete list of all MCP tools exposed by the SOAT server, grouped by module. Each tool name maps directly to the MCP `tools/call` method name.',
  ];

  for (const mod of loadModules()) {
    const tools = loadTools(mod.file);
    if (tools.length === 0) continue;

    sections.push('');
    sections.push(`## ${mod.label}`);
    sections.push('');
    sections.push(
      `See [${mod.label} module docs](${mod.docLink}) for permissions and data model.`
    );
    sections.push('');
    sections.push(renderTable(tools));
  }

  sections.push('');

  fs.writeFileSync(OUTPUT_FILE, sections.join('\n'), 'utf-8');
};

main();
