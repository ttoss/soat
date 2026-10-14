import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonical,
  CLI_DIR,
  CLI_MANIFEST,
  joinContinuations,
  ROOT,
  sliceArray,
} from './common.mjs';

// ── Check 4: documented CLI flags must exist ────────────────────────────────
//
// A documented flag naming no real parameter fails the moment a reader
// copy-pastes it, and nothing else catches it: the tutorials runner executes
// only `docs/tutorials/`, and the regex checks in `docs-lint.mjs` are about
// vocabulary, not existence. The allowlist is derived from the generated route manifest and the
// hand-written wrappers, so this stays a static check.

const assertManifest = () => {
  // The manifest is gitignored, so a fresh clone lacks it until
  // `pnpm run docs-lint` generates it. Fail loudly with the fix rather than an
  // ENOENT trace, and never skip — a check that quietly no-ops is the exact
  // failure this one exists to catch.
  if (!existsSync(CLI_MANIFEST)) {
    console.error(
      'docs-lint: the CLI route manifest is missing, so documented flags cannot be checked.\n' +
        `  expected: ${CLI_MANIFEST.slice(ROOT.length)}\n` +
        '  generate it with: pnpm --filter @soat/cli generate\n' +
        '  (or run the whole check via: pnpm run docs-lint)'
    );
    process.exit(1);
  }
};

const manifestFlags = () => {
  const manifest = readFileSync(CLI_MANIFEST, 'utf-8');
  const commands = new Map();

  // The generator emits exactly one line per route, which is what makes this
  // line-oriented parse reliable.
  for (const line of manifest.split('\n')) {
    const m = line.match(/^\s*'([a-z0-9-]+)':\s*\{/);
    if (!m) continue;
    const allowed = new Set();
    for (const f of sliceArray(line, 'flags').matchAll(/"name":"([^"]+)"/g)) {
      allowed.add(canonical(f[1]));
    }
    for (const key of ['queryParams', 'pathParams']) {
      for (const p of sliceArray(line, key).matchAll(/"([^"]+)"/g)) {
        allowed.add(canonical(p[1]));
      }
    }
    // Accepted on every command that takes a path param, plus the global flags.
    allowed.add('id');
    commands.set(m[1], allowed);
  }
  return commands;
};

/** Wrapper-added flags: real, but absent from the generated manifest. */
const addWrapperFlags = (commands) => {
  const wrappersDir = join(CLI_DIR, 'src/cli-wrappers/wrappers');
  for (const entry of readdirSync(wrappersDir)) {
    const src = readFileSync(join(wrappersDir, entry), 'utf-8');
    const extra = new Set();
    // `const TEMPLATE_FILE_FLAG = 'template-file';` — includes aliases that
    // never appear in `helpFlags`.
    for (const f of src.matchAll(/_FLAG\s*=\s*'([^']+)'/g)) {
      extra.add(canonical(f[1]));
    }
    for (const f of src.matchAll(/name:\s*'([^']+)'/g)) {
      extra.add(canonical(f[1]));
    }
    const commandList = src.match(/COMMANDS\s*=\s*\[([\s\S]*?)\]/);
    if (!commandList) continue;
    for (const c of commandList[1].matchAll(/'([a-z0-9-]+)'/g)) {
      const set = commands.get(c[1]);
      if (set) for (const f of extra) set.add(f);
    }
  }
};

/** command name -> Set of canonical flag names it accepts. */
export const buildCommandFlags = () => {
  assertManifest();
  const commands = manifestFlags();
  addWrapperFlags(commands);
  return commands;
};

// Flags Commander accepts before or after any command.
const GLOBAL_FLAGS = new Set(
  ['help', 'profile', 'base-url', 'token', 'output', 'json'].map(canonical)
);

// CLI-native commands with no REST route behind them.
const NATIVE_COMMANDS = new Set([
  'configure',
  'list-commands',
  'mcp',
  'login',
  'logout',
  'version',
  'listen',
]);

/**
 * Join shell line-continuations so a multi-line invocation is checked as one
 * command, and only start one at a command position (line start, `$(`, `|`,
 * `&&`) so prose mentioning `soat` is not parsed as an invocation.
 */
const collectInvocations = (lines) => {
  return joinContinuations(lines, /(^|\$\(|\|\s*|&&\s*)\s*soat\s+[a-z0-9-]+/);
};

export const checkCliFlags = (files, commandFlags) => {
  const found = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const lines = readFileSync(file, 'utf-8').split('\n');

    for (const { text, line } of collectInvocations(lines)) {
      // Skip any global flag sitting before the command name.
      const m = text.match(
        /soat\s+(?:--[a-zA-Z0-9_-]+(?:[ =]\S+)?\s+)*([a-z][a-z0-9-]*)/
      );
      if (!m) continue;
      const command = m[1];
      if (NATIVE_COMMANDS.has(command)) continue;

      const allowed = commandFlags.get(command);
      if (!allowed) {
        found.push(`${rel}:${line}  [unknown CLI command]  soat ${command}`);
        continue;
      }

      // Stop at a pipe: `| jq -r --arg t ...` belongs to jq, not to soat.
      const ownArgs = text.split('|')[0];
      for (const f of ownArgs.matchAll(/\s--([a-zA-Z0-9_-]+)/g)) {
        const flag = canonical(f[1]);
        if (GLOBAL_FLAGS.has(flag) || allowed.has(flag)) continue;
        found.push(
          `${rel}:${line}  [unknown CLI flag]  soat ${command} --${f[1]}`
        );
      }
    }
  }

  return found;
};
