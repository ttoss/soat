/**
 * Generates the MCP Tools reference from the OpenAPI YAML specs:
 *
 *   docs/mcp/tools.md            — index page linking to one page per module
 *   docs/mcp/tools/<module>.md   — per-module tool list with argument detail
 *
 * Which tools exist and which arguments each takes come from the derivation
 * the server itself runs (`src/lib/soatToolsDerivation.ts`), so the reference
 * lists what a tool accepts and nothing a tool call cannot send.
 *
 * MCP tool names are kebab-case (from `operationId`); argument names are the
 * spec's snake_case property names verbatim, exactly as the runtime
 * `inputSchema` exposes them (`.claude/rules/case-convention.md`).
 *
 * Run with: pnpm tsx scripts/generateMcpToolsDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import {
  loadTools,
  loadToolSurface,
  type ToolArgument,
  type ToolEntry,
} from './mcpToolDocs';
import {
  loadModules,
  type ModuleConfig,
  sanitizeInline,
} from './openapiReferenceHelpers';

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url));
const MCP_DOCS_DIR = path.resolve(scriptsDir, '../docs/mcp');
const INDEX_OUTPUT_FILE = path.join(MCP_DOCS_DIR, 'tools.md');
const TOOLS_OUTPUT_DIR = path.join(MCP_DOCS_DIR, 'tools');

const renderArguments = (args: ToolArgument[]): string => {
  if (args.length === 0) return 'This tool takes no arguments.';

  const header = [
    '| Argument | Type | Required | Description |',
    '| -------- | ---- | -------- | ----------- |',
  ];
  const rows = args.map((arg) => {
    const desc = arg.description ? sanitizeInline(arg.description) : '—';
    // A union/nullable type label (e.g. `array<string> | null`) contains a
    // literal `|`, which Markdown reads as a table cell delimiter even inside
    // backticks — escape it the same way sanitizeInline already does for
    // descriptions, or the cell split breaks MDX's inline-code parsing.
    return `| \`${arg.name}\` | \`${sanitizeInline(arg.type)}\` | ${
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

  const modules = loadModules();
  const surface = loadToolSurface(modules);

  for (const mod of modules) {
    const tools = loadTools({ mod, surface });
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
    'Tool names are **kebab-case**; argument names are **snake_case** — the same names as the REST API, taken verbatim from the OpenAPI specs the tool surface is derived from.',
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
