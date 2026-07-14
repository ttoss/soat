/**
 * Generates the MCP Tools reference from the OpenAPI YAML specs:
 *
 *   docs/mcp/tools.md            — index page linking to one page per module
 *   docs/mcp/tools/<module>.md   — per-module tool list with argument detail
 *
 * The MCP tool surface is derived at runtime by the server from the same specs
 * (`src/lib/soatTools.ts`), so this generator mirrors its two rules:
 *   - operations flagged `x-soat-mcp-exclude` are not exposed as tools;
 *   - request-body fields flagged `x-soat-server-managed` are not tool inputs.
 *
 * MCP tool names and argument names are camelCase (the MCP endpoint is not
 * processed by the snake_case caseTransform middleware).
 *
 * Run with: pnpm tsx scripts/generateMcpToolsDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import {
  type BodyProp,
  getBodyProps,
  getOperationParams,
  loadModules,
  loadOperations,
  mcpToolName,
  type ModuleConfig,
  type OperationEntry,
  type OperationParam,
  sanitizeInline,
} from './openapiReferenceHelpers';

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url));
const MCP_DOCS_DIR = path.resolve(scriptsDir, '../docs/mcp');
const INDEX_OUTPUT_FILE = path.join(MCP_DOCS_DIR, 'tools.md');
const TOOLS_OUTPUT_DIR = path.join(MCP_DOCS_DIR, 'tools');

interface ToolArgument {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface ToolEntry {
  name: string;
  description: string;
  args: ToolArgument[];
}

const paramToArgument = (param: OperationParam): ToolArgument => {
  return {
    name: param.camelName,
    type: param.type,
    required: param.required,
    description: param.description,
  };
};

const bodyPropToArgument = (prop: BodyProp): ToolArgument => {
  return {
    name: prop.camelName,
    type: prop.type,
    required: prop.required,
    description: prop.description,
  };
};

const buildTool = (args: {
  entry: OperationEntry;
  mod: ModuleConfig;
}): ToolEntry | null => {
  const { entry, mod } = args;
  if (entry.operation['x-soat-mcp-exclude']) return null;

  const params = getOperationParams({
    operation: entry.operation,
    spec: mod.spec,
  });
  const bodyProps = getBodyProps({
    operation: entry.operation,
    spec: mod.spec,
    excludeServerManaged: true,
  });

  return {
    name: mcpToolName(entry.operationId),
    description: entry.description,
    args: [
      ...params.map(paramToArgument),
      ...bodyProps.map(bodyPropToArgument),
    ],
  };
};

const loadTools = (mod: ModuleConfig): ToolEntry[] => {
  return loadOperations(mod.spec)
    .map((entry) => {
      return buildTool({ entry, mod });
    })
    .filter((tool): tool is ToolEntry => {
      return tool !== null;
    });
};

const renderArguments = (args: ToolArgument[]): string => {
  if (args.length === 0) return 'This tool takes no arguments.';

  const header = [
    '| Argument | Type | Required | Description |',
    '| -------- | ---- | -------- | ----------- |',
  ];
  const rows = args.map((arg) => {
    const desc = arg.description ? sanitizeInline(arg.description) : '—';
    return `| \`${arg.name}\` | \`${arg.type}\` | ${
      arg.required ? 'yes' : 'no'
    } | ${desc} |`;
  });
  return [...header, ...rows].join('\n');
};

const renderToolSection = (tool: ToolEntry): string => {
  return [
    `### \`${tool.name}\``,
    '',
    tool.description ? sanitizeInline(tool.description) : '—',
    '',
    '#### Arguments',
    '',
    renderArguments(tool.args),
  ].join('\n');
};

const writeModulePage = (args: {
  mod: ModuleConfig;
  tools: ToolEntry[];
  outputFile: string;
}): void => {
  const { mod, tools, outputFile } = args;
  const sections: string[] = [
    '---',
    `title: ${mod.label}`,
    // Explicit slug (relative to the `/docs` base) so routing never depends on
    // the category-index convention — a module whose file basename equals its
    // folder (e.g. `tools/tools.md`) would otherwise lose its own route.
    `slug: /mcp/tools/${mod.file}`,
    '---',
    '',
    `# ${mod.label}`,
    '',
    `MCP tools for the ${mod.label} module. See the [${mod.label} module docs](/docs/modules/${mod.docFile}) for permissions and data model.`,
  ];

  for (const tool of tools) {
    sections.push('');
    sections.push(renderToolSection(tool));
  }

  sections.push('');
  fs.writeFileSync(outputFile, sections.join('\n'), 'utf-8');
};

const cleanGeneratedModulePages = (): void => {
  if (!fs.existsSync(TOOLS_OUTPUT_DIR)) {
    fs.mkdirSync(TOOLS_OUTPUT_DIR, { recursive: true });
    return;
  }
  for (const file of fs.readdirSync(TOOLS_OUTPUT_DIR)) {
    if (file.endsWith('.md')) {
      fs.unlinkSync(path.join(TOOLS_OUTPUT_DIR, file));
    }
  }
};

const main = (): void => {
  cleanGeneratedModulePages();

  const moduleLinks: string[] = [];

  for (const mod of loadModules()) {
    const tools = loadTools(mod);
    if (tools.length === 0) continue;

    const outputFile = path.join(TOOLS_OUTPUT_DIR, `${mod.file}.md`);
    writeModulePage({ mod, tools, outputFile });
    // Absolute site paths, not `./tools/<file>`: the index page is served at
    // both `/docs/mcp/tools` and `/docs/mcp/tools/`, and the trailing-slash
    // variant would resolve a relative link into the subdirectory twice.
    moduleLinks.push(
      `- [${mod.label}](/docs/mcp/tools/${mod.file}) — ${tools.length} tool${
        tools.length === 1 ? '' : 's'
      }`
    );
  }

  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Tools Reference',
    '',
    'Every MCP tool exposed by the SOAT server, grouped by module. Each tool name maps directly to the MCP `tools/call` method name, and its arguments are the tool `inputSchema` fields.',
    '',
    'Tool and argument names are **camelCase** — the MCP endpoint is not processed by the snake_case case-transform applied to the REST API.',
    '',
    '## Modules',
    '',
    ...moduleLinks,
    '',
  ];

  fs.writeFileSync(INDEX_OUTPUT_FILE, sections.join('\n'), 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`MCP tools index written to: ${INDEX_OUTPUT_FILE}`);
  // eslint-disable-next-line no-console
  console.log(`MCP per-module tool docs written to: ${TOOLS_OUTPUT_DIR}`);
};

main();
