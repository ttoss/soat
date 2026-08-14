#!/usr/bin/env node
// WS7 drift guardrail — docs lint.
//
// Greps the website docs for the drift classes the 2026-07 audit found and that
// the module-enhancements sweep removed, so they cannot silently re-accumulate:
//
//   1. Forbidden TypeScript casts in SDK examples (` as any`, ` as unknown`).
//   2. camelCase path params in URL templates (`:paramName`) — the external
//      contract uses snake_case `{param_name}`.
//   3. A stale-term denylist: renamed permission actions / soat-tool actions and
//      the wrong public-ID prefixes fixed by WS2. Runtime prefixes live in
//      packages/postgresdb/src/utils/publicId.ts.
//
// Denylist entries are removed here once a term is legitimately reintroduced.
//
// Usage: node scripts/docs-lint.mjs
// Exits non-zero (and prints every offending line) when any check fails.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS_DIR = join(ROOT, 'packages/website/docs');

/** Recursively collect markdown/MDX files under a directory. */
const collectDocs = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectDocs(full));
    } else if (/\.mdx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Each check is a labelled regex. Wrong-prefix patterns require an id-shaped
 * character right after the prefix (`[0-9A-Za-z]`) and a leading word boundary
 * so English words that merely start with the same letters ("impact", "contact",
 * "half") do not match. `run_` is intentionally omitted: `run_id` is a legitimate
 * orchestration-run path-param / field name, not a wrong prefix.
 */
const CHECKS = [
  // A TypeScript cast ends with a terminator (`)`, `.`, `;`, `,`, `]`, `}`, `>`,
  // backtick, or end of line), so "as any other write" (English prose) is not
  // flagged while `(x as any).foo` and `foo as unknown;` are.
  { label: 'forbidden cast (as any / as unknown)', re: /\bas\s+(any|unknown)\s*([).,;\]}>`]|$)/ },
  // Only flag `:camelCase` route-style path params, not every colon. The
  // lookbehind exempts the two double-curly template tokens, whose key is not a
  // path param and is legitimately camelCase (`{{context:ocaToken}}` — context
  // keys follow the auto-populated `sessionId`/`actorId` spelling).
  {
    label: 'camelCase path param (use snake_case)',
    re: /(?<!\{\{(?:context|secret)):[a-z]+[A-Z][a-zA-Z]*/,
  },
  { label: 'stale action: documents:SearchDocuments', re: /documents:SearchDocuments|\bSearchDocuments\b/ },
  { label: 'stale soat-tool action: search-documents', re: /\bsearch-documents\b/ },
  // Vocabulary reclaim (workflows PRD D1a): the two senses of "workflow" must
  // never cross. An orchestration is a pipeline that ends; a workflow is a
  // state graph a task lives in. So "orchestration workflow" and "workflow
  // pipeline" are both forbidden.
  { label: "forbidden term: 'orchestration workflow' (an orchestration is a pipeline)", re: /orchestration workflows?/i },
  { label: "forbidden term: 'workflow pipeline' (keep the two senses separate)", re: /workflow pipelines?/i },
  // The sync/async execution toggle is `wait` everywhere (documents, sessions,
  // orchestrations, evaluations). The retired `?async=` query parameter must
  // not be documented again in any form.
  { label: "stale toggle: '?async=' (the sync/async toggle is 'wait')", re: /[?&]async=|--async\b|\basync:\s*(true|false)\b/ },
  {
    label: 'wrong public-ID prefix (see publicId.ts)',
    re: /\b(agt_|trc_|actr_|act_[0-9A-Za-z]|tol_|fl_[0-9A-Za-z]|af_[0-9A-Za-z]|afr_|afo_|prj_|usr_|cht_|fil_|me_[0-9A-Za-z])/,
  },
];

// ── Check 4: documented CLI flags must exist ────────────────────────────────
//
// A documented `soat <cmd> --flag` that names no real parameter fails the moment
// a reader copy-pastes it. Nothing else catches this: the tutorials runner
// executes only `docs/tutorials/`, so `docs/modules/` CLI tabs are never run,
// and the regex checks above are about vocabulary, not existence. That is how
// `--content_base64` — a field no endpoint has ever accepted — survived in all
// three tabs of one page.
//
// The allowlist is derived from the two in-repo sources of truth, so this stays
// a static check with no server and no dependencies:
//   - packages/cli/src/generated/routes.ts   (generated from the OpenAPI specs)
//   - packages/cli/src/cli-wrappers/wrappers (flags a wrapper adds by hand)

const CLI_DIR = join(ROOT, 'packages/cli');

/** Canonicalize a flag/param name so snake, kebab, and camel spellings match —
 * the CLI's own parser is lenient the same way (see `toCanonical` in index.ts). */
const canonical = (s) => {
  return s.replace(/[-_]([a-z0-9])/g, (_, c) => {
    return c.toUpperCase();
  });
};

/** Slice `key: [ ... ]` out of a line, counting brackets so a nested array
 * inside a flag description does not end the match early. */
const sliceArray = (line, key) => {
  const start = line.indexOf(`${key}: [`);
  if (start === -1) return '';
  let depth = 0;
  const from = line.indexOf('[', start);
  for (let i = from; i < line.length; i++) {
    if (line[i] === '[') depth++;
    else if (line[i] === ']') {
      depth--;
      if (depth === 0) return line.slice(from, i + 1);
    }
  }
  return '';
};

/** command name -> Set of canonical flag names it accepts. */
const buildCommandFlags = () => {
  const manifest = readFileSync(
    join(CLI_DIR, 'src/generated/routes.ts'),
    'utf-8'
  );
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

  // Wrapper-added flags: real, but absent from the generated manifest.
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
  const out = [];
  let buf = null;
  let startLine = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trimEnd();
    if (buf !== null) {
      buf += ` ${trimmed.replace(/\\$/, '')}`;
      if (!trimmed.endsWith('\\')) {
        out.push({ text: buf, line: startLine });
        buf = null;
      }
      return;
    }
    if (!/(^|\$\(|\|\s*|&&\s*)\s*soat\s+[a-z0-9-]+/.test(trimmed)) return;
    startLine = idx + 1;
    if (trimmed.endsWith('\\')) buf = trimmed.replace(/\\$/, '');
    else out.push({ text: trimmed, line: startLine });
  });

  return out;
};

const checkCliFlags = (commandFlags) => {
  const found = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const lines = readFileSync(file, 'utf-8').split('\n');

    for (const { text, line } of collectInvocations(lines)) {
      // Skip any global flag sitting before the command name.
      const m = text.match(/soat\s+(?:--[a-zA-Z0-9_-]+(?:[ =]\S+)?\s+)*([a-z][a-z0-9-]*)/);
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

const files = collectDocs(DOCS_DIR);
const violations = [];

for (const file of files) {
  const rel = file.slice(ROOT.length);
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    for (const check of CHECKS) {
      if (check.re.test(line)) {
        violations.push(`${rel}:${i + 1}  [${check.label}]  ${line.trim()}`);
      }
    }
  });
}

violations.push(...checkCliFlags(buildCommandFlags()));

if (violations.length > 0) {
  console.error(`docs-lint: ${violations.length} violation(s) found:\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nFix the offending docs. Runtime ID prefixes: packages/postgresdb/src/utils/publicId.ts'
  );
  process.exit(1);
}

console.log(`docs-lint: OK (${files.length} files scanned, no violations).`);
