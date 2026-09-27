/**
 * Every call in the handwritten docs is shown for the CLI, the SDK and curl,
 * in one `<Tabs groupId="client">` block, in that order. Module pages must
 * carry at least one such block; other pages only when they show a call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const DOCS_DIR = path.resolve(__dirname, '../docs');

const CLIENTS = ['cli', 'sdk', 'curl'] as const;

type Client = (typeof CLIENTS)[number];

/** Handwritten pages that document one client on purpose. */
const EXEMPT: Record<string, string> = {
  'cli/introduction.md': 'the CLI guide documents one client',
  'cli/usage.md': 'the CLI guide documents one client',
  'sdk/introduction.md': 'the SDK guide documents one client',
  'sdk/usage.md': 'the SDK guide documents one client',
  'mcp/connecting.md': 'MCP transport calls have no CLI or SDK form',
  'modules/docs.md': 'the docs tools are served over MCP only',
  'modules/iam.md': 'policy document reference, no calls',
  'modules/index.md': 'index page, no calls of its own',
  'modules/oauth.md': 'RFC-fixed endpoints outside the SDK and CLI surface',
};

/** Generated output, not handwritten. */
const GENERATED_DIRS = ['api', 'cli/commands', 'sdk/services', 'mcp/tools'];

const REQUIRED_DIRS = ['modules/'];

type TabsFrame = {
  groupId: string;
  items: { blocks: number; value: string }[];
  line: number;
};

const listMarkdownFiles = (args: { dir: string; prefix?: string }): string[] => {
  return fs
    .readdirSync(args.dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = args.prefix ? `${args.prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (GENERATED_DIRS.includes(rel)) return [];
        return listMarkdownFiles({ dir: path.join(args.dir, entry.name), prefix: rel });
      }
      return /\.mdx?$/.test(entry.name) ? [rel] : [];
    })
    .sort();
};

/** The client a code block is a call for, or undefined when it is no call. */
const clientOf = (args: { content: string; language: string }): Client | undefined => {
  const { content, language } = args;
  if (['bash', 'sh', 'shell'].includes(language)) {
    if (/(^|\n)\s*curl\s/.test(content)) return 'curl';
    if (/(^|\n)\s*soat\s+[a-z]/.test(content)) return 'cli';
    return undefined;
  }
  if (['js', 'javascript', 'ts', 'tsx', 'typescript'].includes(language)) {
    return /\bsoat\.[a-zA-Z]+\.[a-zA-Z]+\(/.test(content) ? 'sdk' : undefined;
  }
  return undefined;
};

const enclosingClientTab = (stack: TabsFrame[]): string | undefined => {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame?.groupId === 'client') return frame.items.at(-1)?.value;
  }
  return undefined;
};

export const checkSource = (args: { file: string; source: string }): string[] => {
  const { file, source } = args;
  const problems: string[] = [];
  const lines = source.split('\n');
  const stack: TabsFrame[] = [];
  let clientTabSets = 0;
  let openFence: { language: string; line: number; text: string[] } | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      if (openFence) {
        const client = clientOf({
          content: openFence.text.join('\n'),
          language: openFence.language,
        });
        const tab = enclosingClientTab(stack);
        for (const frame of stack) {
          const item = frame.items.at(-1);
          if (item) item.blocks += 1;
        }
        if (client && !tab) {
          problems.push(
            `${file}:${openFence.line} a ${client} example outside a <Tabs groupId="client"> block — show the same call for ${CLIENTS.join(', ')}`
          );
        } else if (client && tab !== client) {
          problems.push(`${file}:${openFence.line} a ${client} example inside the "${tab}" tab`);
        }
        openFence = undefined;
      } else {
        openFence = { language: fence[1] ?? '', line: lineNumber, text: [] };
      }
      return;
    }

    if (openFence) {
      openFence.text.push(line);
      return;
    }

    const tabsOpen = /^\s*<Tabs\b([^>]*)>/.exec(line);
    if (tabsOpen) {
      const groupId = /groupId="([^"]+)"/.exec(tabsOpen[1] ?? '')?.[1] ?? '';
      if (groupId === 'client') clientTabSets += 1;
      stack.push({ groupId, items: [], line: lineNumber });
      return;
    }

    if (/^\s*<\/Tabs>/.test(line)) {
      const frame = stack.pop();
      if (!frame) {
        problems.push(`${file}:${lineNumber} </Tabs> without a matching <Tabs>`);
        return;
      }
      if (frame.groupId !== 'client') return;
      const values = frame.items.map((item) => item.value);
      if (values.join(',') !== CLIENTS.join(',')) {
        problems.push(
          `${file}:${frame.line} client tabs are [${values.join(', ') || 'none'}] — expected exactly [${CLIENTS.join(', ')}], in that order`
        );
      }
      for (const item of frame.items) {
        if (item.blocks === 0) {
          problems.push(`${file}:${frame.line} the "${item.value}" tab has no example in it`);
        }
      }
      return;
    }

    const tabItem = /^\s*<TabItem\b[^>]*value="([^"]+)"/.exec(line);
    if (tabItem) stack.at(-1)?.items.push({ blocks: 0, value: tabItem[1] ?? '' });
  });

  if (clientTabSets === 0 && REQUIRED_DIRS.some((dir) => file.startsWith(dir))) {
    problems.push(`${file} has no <Tabs groupId="client"> block — module pages show their key operations for ${CLIENTS.join(', ')}`);
  }

  if (clientTabSets > 0) {
    for (const component of ['Tabs', 'TabItem']) {
      if (!new RegExp(`import ${component} from '@theme/${component}'`).test(source)) {
        problems.push(`${file} uses <${component}> without importing it from @theme/${component}`);
      }
    }
  }

  return problems;
};

const run = () => {
  const files = listMarkdownFiles({ dir: DOCS_DIR }).filter((file) => !(file in EXEMPT));
  const problems = files.flatMap((file) => {
    return checkSource({ file, source: fs.readFileSync(path.join(DOCS_DIR, file), 'utf8') });
  });
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} docs example problem(s) — show every call for CLI, SDK and curl:\n  ${problems.join('\n  ')}`
    );
  }
  process.stdout.write(`[client-examples] ${files.length} page(s) checked\n`);
};

if (process.argv[1] === url.fileURLToPath(import.meta.url)) run();
