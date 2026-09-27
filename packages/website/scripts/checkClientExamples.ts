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

/** Marks the next block as a call only one client can make; a reason is required. */
const SINGLE_CLIENT = /^\s*\{\/\*\s*single-client:\s*\S.*\*\/\}\s*$/;

const REQUIRED_DIRS = ['modules/'];

type TabsFrame = {
  groupId: string;
  items: { blocks: number; value: string }[];
  line: number;
};

const listMarkdownFiles = (args: {
  dir: string;
  prefix?: string;
}): string[] => {
  return fs
    .readdirSync(args.dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = args.prefix ? `${args.prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (GENERATED_DIRS.includes(rel)) return [];
        return listMarkdownFiles({
          dir: path.join(args.dir, entry.name),
          prefix: rel,
        });
      }
      return /\.mdx?$/.test(entry.name) ? [rel] : [];
    })
    .sort();
};

/** The client a code block is a call for, or undefined when it is no call. */
const clientOf = (args: {
  content: string;
  language: string;
}): Client | undefined => {
  const { content, language } = args;
  if (['bash', 'sh', 'shell'].includes(language)) {
    // `/hooks/` endpoints are called by third parties, never by a SOAT client.
    if (/(^|\n)\s*curl\s/.test(content)) {
      return /\/hooks\//.test(content) ? undefined : 'curl';
    }
    // `soat listen` is a local webhook receiver, not an API call.
    if (/(^|\n)\s*soat\s+(?!listen\b)[a-z]/.test(content)) return 'cli';
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

type Fence = {
  language: string;
  line: number;
  singleClient: boolean;
  text: string[];
};

type ScanState = {
  clientTabSets: number;
  file: string;
  openFence: Fence | undefined;
  problems: string[];
  stack: TabsFrame[];
};

const closeFence = (args: { fence: Fence; state: ScanState }) => {
  const { fence, state } = args;
  const client = clientOf({
    content: fence.text.join('\n'),
    language: fence.language,
  });
  const tab = enclosingClientTab(state.stack);
  for (const frame of state.stack) {
    const item = frame.items.at(-1);
    if (item) item.blocks += 1;
  }
  if (!client || (!tab && fence.singleClient)) return;
  if (!tab) {
    state.problems.push(
      `${state.file}:${fence.line} a ${client} example outside a <Tabs groupId="client"> block — show the same call for ${CLIENTS.join(', ')}`
    );
  } else if (tab !== client) {
    state.problems.push(
      `${state.file}:${fence.line} a ${client} example inside the "${tab}" tab`
    );
  }
};

const closeTabs = (args: { lineNumber: number; state: ScanState }) => {
  const { lineNumber, state } = args;
  const frame = state.stack.pop();
  if (!frame) {
    state.problems.push(
      `${state.file}:${lineNumber} </Tabs> without a matching <Tabs>`
    );
    return;
  }
  if (frame.groupId !== 'client') return;
  const values = frame.items.map((item) => {
    return item.value;
  });
  if (values.join(',') !== CLIENTS.join(',')) {
    state.problems.push(
      `${state.file}:${frame.line} client tabs are [${values.join(', ') || 'none'}] — expected exactly [${CLIENTS.join(', ')}], in that order`
    );
  }
  for (const item of frame.items) {
    if (item.blocks === 0) {
      state.problems.push(
        `${state.file}:${frame.line} the "${item.value}" tab has no example in it`
      );
    }
  }
};

const scanMarkup = (args: {
  line: string;
  lineNumber: number;
  state: ScanState;
}) => {
  const { line, lineNumber, state } = args;
  const tabsOpen = /^\s*<Tabs\b([^>]*)>/.exec(line);
  if (tabsOpen) {
    const groupId = /groupId="([^"]+)"/.exec(tabsOpen[1] ?? '')?.[1] ?? '';
    if (groupId === 'client') state.clientTabSets += 1;
    state.stack.push({ groupId, items: [], line: lineNumber });
    return;
  }
  if (/^\s*<\/Tabs>/.test(line)) {
    closeTabs({ lineNumber, state });
    return;
  }
  const tabItem = /^\s*<TabItem\b[^>]*value="([^"]+)"/.exec(line);
  if (tabItem) {
    state.stack.at(-1)?.items.push({ blocks: 0, value: tabItem[1] ?? '' });
  }
};

const pageProblems = (args: {
  clientTabSets: number;
  file: string;
  source: string;
}): string[] => {
  const { clientTabSets, file, source } = args;
  const problems: string[] = [];
  if (
    clientTabSets === 0 &&
    REQUIRED_DIRS.some((dir) => {
      return file.startsWith(dir);
    })
  ) {
    problems.push(
      `${file} has no <Tabs groupId="client"> block — module pages show their key operations for ${CLIENTS.join(', ')}`
    );
  }

  if (clientTabSets > 0) {
    for (const component of ['Tabs', 'TabItem']) {
      if (
        !new RegExp(`import ${component} from '@theme/${component}'`).test(
          source
        )
      ) {
        problems.push(
          `${file} uses <${component}> without importing it from @theme/${component}`
        );
      }
    }
  }

  return problems;
};

export const checkSource = (args: {
  file: string;
  source: string;
}): string[] => {
  const { file, source } = args;
  const lines = source.split('\n');
  const state: ScanState = {
    clientTabSets: 0,
    file,
    openFence: undefined,
    problems: [],
    stack: [],
  };

  for (const [index, line] of lines.entries()) {
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence && state.openFence) {
      closeFence({ fence: state.openFence, state });
      state.openFence = undefined;
    } else if (fence) {
      state.openFence = {
        language: fence[1] ?? '',
        line: index + 1,
        singleClient: SINGLE_CLIENT.test(lines[index - 1] ?? ''),
        text: [],
      };
    } else if (state.openFence) {
      state.openFence.text.push(line);
    } else {
      scanMarkup({ line, lineNumber: index + 1, state });
    }
  }

  return [
    ...state.problems,
    ...pageProblems({ file, source, clientTabSets: state.clientTabSets }),
  ];
};

const run = () => {
  const files = listMarkdownFiles({ dir: DOCS_DIR }).filter((file) => {
    return !(file in EXEMPT);
  });
  const problems = files.flatMap((file) => {
    return checkSource({
      file,
      source: fs.readFileSync(path.join(DOCS_DIR, file), 'utf8'),
    });
  });
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} docs example problem(s) — show every call for CLI, SDK and curl:\n  ${problems.join('\n  ')}`
    );
  }
  process.stdout.write(`[client-examples] ${files.length} page(s) checked\n`);
};

if (process.argv[1] === url.fileURLToPath(import.meta.url)) run();
