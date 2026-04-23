/**
 * Generates packages/website/docs/mcp/tools.md from soat-tools source files.
 * Run with: pnpm tsx scripts/generateMcpToolsDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SOAT_TOOLS_DIR = path.resolve(
  __dirname,
  '../../server/src/lib/soat-tools'
);

const OUTPUT_FILE = path.resolve(__dirname, '../docs/mcp/tools.md');

interface ToolEntry {
  name: string;
  description: string;
}

interface ModuleConfig {
  file: string;
  label: string;
  docLink: string;
}

const MODULES: ModuleConfig[] = [
  { file: 'actors', label: 'Actors', docLink: '../modules/actors.md' },
  { file: 'agents', label: 'Agents', docLink: '../modules/agents.md' },
  {
    file: 'aiProviders',
    label: 'AI Providers',
    docLink: '../modules/ai-providers.md',
  },
  { file: 'chats', label: 'Chats', docLink: '../modules/chats.md' },
  {
    file: 'conversations',
    label: 'Conversations',
    docLink: '../modules/conversations.md',
  },
  {
    file: 'documents',
    label: 'Documents',
    docLink: '../modules/documents.md',
  },
  { file: 'files', label: 'Files', docLink: '../modules/files.md' },
  { file: 'projects', label: 'Projects', docLink: '../modules/projects.md' },
  { file: 'secrets', label: 'Secrets', docLink: '../modules/secrets.md' },
  { file: 'sessions', label: 'Sessions', docLink: '../modules/sessions.md' },
  { file: 'webhooks', label: 'Webhooks', docLink: '../modules/webhooks.md' },
];

const loadTools = async (moduleName: string): Promise<ToolEntry[]> => {
  const filePath = path.join(SOAT_TOOLS_DIR, `${moduleName}.ts`);
  const mod = await import(filePath);
  const tools: ToolEntry[] = (mod.tools ?? []).map(
    (t: { name: string; description: string }) => {
      return {
        name: t.name,
        description: t.description,
      };
    }
  );
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

const main = async () => {
  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Tools Reference',
    '',
    'Complete list of all MCP tools exposed by the SOAT server, grouped by module. Each tool name maps directly to the MCP `tools/call` method name.',
  ];

  for (const mod of MODULES) {
    const tools = await loadTools(mod.file);
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

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
