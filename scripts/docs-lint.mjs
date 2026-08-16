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
//   4. A documented `soat <cmd> --flag` naming no real CLI parameter.
//   5. A documented SDK or curl request-body field naming no real body property.
//   6. An endpoint mention (`METHOD /path`) that does not link to its generated
//      API-reference page — and any /docs/api/ link addressing a page no
//      operation generates.
//
// Checks 4 and 5 are existence checks against the in-repo sources of truth, and
// they cover all three tabs every module example ships. Guarding one language is
// what let three of the four examples #992 reported stay broken after the fix:
// the CLI tab was corrected, and the SDK and curl tabs of the same example kept
// the field name no endpoint accepts.
//
// Denylist entries are removed here once a term is legitimately reintroduced.
//
// Usage: node scripts/docs-lint.mjs
// Exits non-zero (and prints every offending line) when any check fails.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  {
    label: 'forbidden cast (as any / as unknown)',
    re: /\bas\s+(any|unknown)\s*([).,;\]}>`]|$)/,
  },
  // Only flag `:camelCase` route-style path params, not every colon. The
  // lookbehind exempts the two double-curly template tokens, whose key is not a
  // path param and is legitimately camelCase (`{{context:ocaToken}}` — context
  // keys follow the auto-populated `sessionId`/`actorId` spelling).
  {
    label: 'camelCase path param (use snake_case)',
    re: /(?<!\{\{(?:context|secret)):[a-z]+[A-Z][a-zA-Z]*/,
  },
  {
    label: 'stale action: documents:SearchDocuments',
    re: /documents:SearchDocuments|\bSearchDocuments\b/,
  },
  {
    label: 'stale soat-tool action: search-documents',
    re: /\bsearch-documents\b/,
  },
  // Vocabulary reclaim (workflows PRD D1a): the two senses of "workflow" must
  // never cross. An orchestration is a pipeline that ends; a workflow is a
  // state graph a task lives in. So "orchestration workflow" and "workflow
  // pipeline" are both forbidden.
  {
    label:
      "forbidden term: 'orchestration workflow' (an orchestration is a pipeline)",
    re: /orchestration workflows?/i,
  },
  {
    label: "forbidden term: 'workflow pipeline' (keep the two senses separate)",
    re: /workflow pipelines?/i,
  },
  // The sync/async execution toggle is `wait` everywhere (documents, sessions,
  // orchestrations, evaluations). The retired `?async=` query parameter must
  // not be documented again in any form.
  {
    label: "stale toggle: '?async=' (the sync/async toggle is 'wait')",
    re: /[?&]async=|--async\b|\basync:\s*(true|false)\b/,
  },
  // Fields removed for v1 (#997, #1005). `\btool_ids\b` does not match
  // `active_tool_ids`, which is still a real field — `_` is a word character, so
  // there is no boundary before `tool_ids` there. The `tools` shorthand gets no
  // entry: the word is far too common to denylist, and a documented `--tools`
  // flag is already caught by the CLI-flag check below.
  {
    label: "removed field: 'tool_ids' (agents attach tools via tool_bindings)",
    re: /\btool_ids\b/,
  },
  // Stored shapes that are no longer read (#1005): the camelCase spellings of
  // step-rule keys, a forced tool's name, and an http tool's body mode. The wire
  // — and documented — spellings are tool_choice / active_tool_ids / tool_name /
  // body_mode.
  {
    label: 'retired camelCase spelling (use the snake_case wire name)',
    re: /\b(toolChoice|activeToolIds|toolName|bodyMode)\b/,
  },
  // The API's only error shape is `{ error: { code, message, meta? } }`
  // (`.claude/rules/errors.md`), and the SDK's `error` *is* that raw body — the
  // CLI spreads it unwrapped for exactly that reason. So the code always lives
  // one level down, at `error.error.code`. A doc that reads `error.code`
  // prints `undefined` for the one value the step exists to show, and the
  // tutorials runner cannot catch it: it executes only the CLI tab, so the SDK
  // and curl tabs of the same step are never run.
  //
  // `[\w$]*` cannot span a dot, so the correct `x.error.code` never matches.
  {
    label:
      'SDK error shape: the body nests under `error` (use `error.error.code`)',
    re: /console\.log\([A-Za-z_$][\w$]*\.(?:code|meta)\)/,
  },
  // The curl half of the same mistake: `jq '{code}'` over an error body yields
  // `{"code": null}`. The correct projection names the path — `.error.code`.
  {
    label: "curl error shape: `jq '{code}'` reads null (use `.error.code`)",
    re: /jq '\{code[,}]/,
  },
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
  const manifestPath = join(CLI_DIR, 'src/generated/routes.ts');

  // The manifest is generated from the OpenAPI specs and gitignored, so it is
  // absent in a fresh clone. `pnpm run docs-lint` generates it first; a bare
  // `node scripts/docs-lint.mjs` may not have. Fail loudly with the fix rather
  // than an ENOENT stack trace — and never skip the check, since a check that
  // quietly no-ops is the exact failure this one exists to catch.
  if (!existsSync(manifestPath)) {
    console.error(
      'docs-lint: the CLI route manifest is missing, so documented flags cannot be checked.\n' +
        `  expected: ${manifestPath.slice(ROOT.length)}\n` +
        '  generate it with: pnpm --filter @soat/cli generate\n' +
        '  (or run the whole check via: pnpm run docs-lint)'
    );
    process.exit(1);
  }

  const manifest = readFileSync(manifestPath, 'utf-8');
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

  for (const [idx, line] of lines.entries()) {
    const trimmed = line.trimEnd();
    if (buf !== null) {
      buf += ` ${trimmed.replace(/\\$/, '')}`;
      if (!trimmed.endsWith('\\')) {
        out.push({ text: buf, line: startLine });
        buf = null;
      }
      continue;
    }
    if (!/(^|\$\(|\|\s*|&&\s*)\s*soat\s+[a-z0-9-]+/.test(trimmed)) continue;
    startLine = idx + 1;
    if (trimmed.endsWith('\\')) buf = trimmed.replace(/\\$/, '');
    else out.push({ text: trimmed, line: startLine });
  }

  return out;
};

const checkCliFlags = (files, commandFlags) => {
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

// ── Check 5: documented SDK / curl body fields must exist ───────────────────
//
// Check 4 covers CLI tabs only, which is exactly how three of the four examples
// #992 reported stayed broken after being "fixed": the CLI tab was corrected and
// the SDK and curl tabs of the same example kept the field name no endpoint
// accepts (`prompt` for `messages`, `content` for `message`). Every module
// example ships all three languages, so checking one of them leaves two thirds
// of the surface unguarded — and a reader on the SDK tab has no working tab to
// fall back to.
//
// `strictFields` answers `400 VALIDATION_FAILED` for these at runtime, so the
// examples fail on copy-paste exactly like the CLI ones did. Nothing executes
// them: the tutorials runner extracts `<TabItem value="cli">` blocks only.
//
// Scope is deliberately the **top-level** field names of a JSON request body,
// which is where every reported instance lived. Nested objects are not checked —
// the CLI manifest flattens a body to its top-level flags, so a nested schema is
// not available from the same static source.

const OPENAPI_DIR = join(ROOT, 'packages/server/src/rest/openapi/v1');

/** operationId -> Set of canonical top-level body field names. */
const buildBodyFields = () => {
  const manifest = readFileSync(
    join(CLI_DIR, 'src/generated/routes.ts'),
    'utf-8'
  );
  const byOperation = new Map();

  for (const line of manifest.split('\n')) {
    const op = line.match(/operationId:\s*'([A-Za-z0-9]+)'/);
    if (!op) continue;

    // Pair each `"name"` with the `"in"` that follows it, rather than matching a
    // whole flag object: a flag `description` may itself contain braces, which
    // makes any `\{...\}` pattern skip exactly the richest flags (`tool_bindings`
    // among them).
    const flags = sliceArray(line, 'flags');
    const fields = new Set();
    for (const f of flags.matchAll(/"name":"([^"]+)"/g)) {
      const next = flags.slice(f.index).match(/"in":"(path|query|body)"/);
      if (next?.[1] === 'body') fields.add(canonical(f[1]));
    }
    byOperation.set(op[1], fields);
  }

  return byOperation;
};

/**
 * `METHOD /api/v1/path/{param}` -> operationId, read from the specs that are the
 * source of truth for every generated client. Needed only by the curl check: a
 * curl snippet names a URL where the SDK names the operation outright.
 */
const buildRouteIndex = () => {
  const index = [];

  for (const entry of readdirSync(OPENAPI_DIR)) {
    if (!entry.endsWith('.yaml')) continue;
    let path = null;
    let method = null;
    for (const line of readFileSync(join(OPENAPI_DIR, entry), 'utf-8').split(
      '\n'
    )) {
      const pathMatch = line.match(/^ {2}(\/\S+):\s*$/);
      if (pathMatch) {
        path = pathMatch[1];
        method = null;
        continue;
      }
      const methodMatch = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
      if (methodMatch) {
        method = methodMatch[1];
        continue;
      }
      const opMatch = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
      if (opMatch && path && method) {
        // A path template becomes a regex so a concrete example URL
        // (`/agents/agent_01/generate`) matches its declared shape.
        index.push({
          method,
          re: new RegExp(
            `^${path.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/')}$`
          ),
          operationId: opMatch[1],
          // The spec file's basename is the reference page's directory: the
          // OpenAPI plugin is configured per spec with `outputDir:
          // docs/api/<name>` (packages/website/docusaurus.config.ts).
          module: entry.replace(/\.yaml$/, ''),
        });
      }
    }
  }

  return index;
};

/**
 * The top-level entries of the brace-delimited object starting at `from`, each as
 * `{ key, valueStart }`. Null when that position is not an object literal (a
 * variable was passed instead of a literal — nothing to check) or the object is
 * unterminated.
 *
 * Bounded to the object it is given: reading the *next* `body:` anywhere in the
 * file instead would attribute a later example's fields to this call, which is
 * how the first draft of this check reported 180 phantom violations.
 */
export const objectEntriesAt = (text, from) => {
  const open = text.indexOf('{', from);
  if (open === -1 || text.slice(from, open).trim() !== '') return null;

  const entries = [];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    // Read string and template literals as one unit, so a value never reads as
    // structure: without this, `url: 'https://…'` reports a field named `https`
    // and any prose containing a colon becomes a key. A quoted string *is* a key
    // when a colon follows it — which is how every JSON key is spelled.
    if (ch === '"' || ch === "'" || ch === '`') {
      const from = i;
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i++;
        i++;
      }
      const after = text.slice(i + 1).match(/^\s*:/);
      if (depth === 1 && after) {
        const name = text.slice(from + 1, i);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          entries.push({
            key: name,
            valueStart: i + 1 + after[0].length,
          });
        }
      }
      continue;
    }

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return entries;
    } else if (depth === 1) {
      const key = text.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (key && /[{,\s]/.test(text[i - 1] ?? '')) {
        entries.push({ key: key[1], valueStart: i + key[0].length });
      }
    }
  }
  return null;
};

const objectKeysAt = (text, from) => {
  return (
    objectEntriesAt(text, from)?.map((entry) => {
      return entry.key;
    }) ?? null
  );
};

const checkSdkBodyFields = (files, bodyFields, serviceSegments) => {
  const found = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const text = readFileSync(file, 'utf-8');
    const lineAt = (index) => {
      return text.slice(0, index).split('\n').length;
    };

    for (const call of text.matchAll(
      /\b[A-Za-z_$][\w$]*\.([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)\(\{/g
    )) {
      const [service, operationId] = [call[1], call[2]];
      if (!serviceSegments.has(service)) continue;

      const allowed = bodyFields.get(operationId);
      if (!allowed) {
        found.push(
          `${rel}:${lineAt(call.index)}  [unknown SDK operation]  ${service}.${operationId}`
        );
        continue;
      }
      // An empty set means the manifest describes no body for this operation —
      // `upload-file` is `multipart/form-data`, which the flag generator does not
      // flatten. That is "unknown", not "nothing allowed", so there is nothing to
      // check against.
      if (allowed.size === 0) continue;

      // `body` among this call's own argument keys. A call with no body (a GET)
      // has nothing to check.
      const args = objectEntriesAt(text, call.index + call[0].length - 1);
      const body = args?.find((entry) => {
        return entry.key === 'body';
      });
      if (!body) continue;

      const keys = objectKeysAt(text, body.valueStart);
      if (!keys) continue;

      for (const key of keys) {
        if (allowed.has(canonical(key))) continue;
        found.push(
          `${rel}:${lineAt(call.index)}  [unknown SDK body field]  ${operationId} body.${key}`
        );
      }
    }
  }

  return found;
};

const checkCurlBodyFields = (files, bodyFields, routeIndex) => {
  const found = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const lines = readFileSync(file, 'utf-8').split('\n');

    // Join shell line-continuations, the same way `collectInvocations` does, so
    // the URL and the `-d` payload of one curl are seen together.
    const commands = [];
    let buf = null;
    let startLine = 0;
    for (const [idx, line] of lines.entries()) {
      const trimmed = line.trimEnd();
      if (buf !== null) {
        buf += ` ${trimmed.replace(/\\$/, '')}`;
        if (!trimmed.endsWith('\\')) {
          commands.push({ text: buf, line: startLine });
          buf = null;
        }
        continue;
      }
      if (!/^\s*curl\s/.test(trimmed)) continue;
      startLine = idx + 1;
      if (trimmed.endsWith('\\')) buf = trimmed.replace(/\\$/, '');
      else commands.push({ text: trimmed, line: startLine });
    }

    for (const { text, line } of commands) {
      const payload = text.match(/-d\s+'([\s\S]*)'/);
      if (!payload) continue;

      const url = text.match(/https?:\/\/[^\s'"]+/);
      if (!url) continue;
      const pathname = url[0].replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      const method = (text.match(/-X\s+([A-Z]+)/)?.[1] ?? 'POST').toLowerCase();

      const route = routeIndex.find((r) => {
        return r.method === method && r.re.test(pathname);
      });
      if (!route) continue;

      const allowed = bodyFields.get(route.operationId);
      if (!allowed || allowed.size === 0) continue;

      // A payload carrying a shell variable or a `<placeholder>` is not JSON;
      // its keys are still readable structurally.
      const keys = objectKeysAt(payload[1], 0);
      if (!keys) continue;

      for (const key of keys) {
        if (allowed.has(canonical(key))) continue;
        found.push(
          `${rel}:${line}  [unknown curl body field]  ${route.operationId} body.${key}`
        );
      }
    }
  }

  return found;
};

// ── Check 6: an endpoint mention must link to its reference page ─────────────
//
// A reader who meets `POST /api/v1/documents/ingest` in prose wants the request
// schema, and the generated reference page has it. Linking only the first
// mention of a page was the initial plan and is the wrong cut: reference docs
// are entered by deep link — search results, `#re-ingesting-a-document`, a
// cross-page anchor — so a reader landing mid-page never sees the top of it.
// "Every resolvable mention is linked" is also the only version of the rule a
// script can check; "the first one" is an ordinal judgement that each new page
// would have to remember.
//
// The address is derived, not stored: `docs/api/` is gitignored, so the slug
// only exists after a generator runs. `pr.yml` skips the website build whenever
// a PR touches Markdown only, which is precisely the PR that adds these links —
// so a typo would otherwise surface at the next release deploy.
//
// A mention that resolves to no operation is left alone: `POST /chat/completions`
// and `POST /v1/stt` are provider-side, and "every mutating `POST` … under
// `/api/v1`" names a class, not a route.

/**
 * The slug `docusaurus-plugin-openapi-docs` derives from an `operationId`,
 * which is lodash `kebabCase` — note it splits a digit run into its own word
 * (`downloadFileBase64` -> `download-file-base-64`), which a plain
 * camel-boundary split gets wrong.
 */
export const operationSlug = (operationId) => {
  return (
    operationId.match(
      /[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|\b)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g
    ) ?? []
  )
    .map((word) => {
      return word.toLowerCase();
    })
    .join('-');
};

/**
 * Every `` `METHOD /path` `` token in a page, with whether it is already inside
 * a Markdown link. Fenced blocks are skipped: their content is copy-pasted
 * verbatim, so a link cannot be added there.
 */
export const scanReferenceMentions = (text) => {
  const mentions = [];
  let fenced = false;

  for (const [i, line] of text.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const m of line.matchAll(
      /`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s]*)`/g
    )) {
      const before = line[m.index - 1];
      const after = line.slice(m.index + m[0].length);
      mentions.push({
        line: i + 1,
        token: m[0],
        method: m[1].toLowerCase(),
        // A query string is not part of the route: `GET /usage/meters?source=eval`
        // is `listUsageMeters`. A trailing `/` is not either.
        path: m[2].split(/[?#]/)[0].replace(/\/$/, ''),
        linked: before === '[' && /^\]\(/.test(after),
      });
    }
  }

  return mentions;
};

/** The route a mention names, or null when it names none. */
const resolveMention = (routeIndex, mention) => {
  // A wildcard or elision is a class of routes, not one operation.
  if (/[*…]/.test(mention.path)) return null;

  // Docs write the path both with and without the `/api/v1` prefix the specs
  // declare; `:id` and `{document_id}` both match the index's `[^/]+` segments.
  const candidates = mention.path.startsWith('/api/v1/')
    ? [mention.path]
    : [`/api/v1${mention.path}`, mention.path];

  for (const path of candidates) {
    const route = routeIndex.find((r) => {
      return r.method === mention.method && r.re.test(path);
    });
    if (route) return route;
  }
  return null;
};

export const referencePath = (route) => {
  return `/docs/api/${route.module}/${operationSlug(route.operationId)}`;
};

const checkReferenceLinks = (files, routeIndex) => {
  const found = [];
  const known = new Set(
    routeIndex.map((route) => {
      return referencePath(route);
    })
  );

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const text = readFileSync(file, 'utf-8');

    for (const mention of scanReferenceMentions(text)) {
      if (mention.linked) continue;
      const route = resolveMention(routeIndex, mention);
      if (!route) continue;
      found.push(
        `${rel}:${mention.line}  [unlinked API reference]  ${mention.token} -> ${referencePath(route)}`
      );
    }

    // The other direction: a link addressing a page no operation generates.
    for (const [i, line] of text.split('\n').entries()) {
      for (const link of line.matchAll(/\]\((\/docs\/api\/[^)#\s]+)\)/g)) {
        if (known.has(link[1])) continue;
        found.push(`${rel}:${i + 1}  [unknown API reference link]  ${link[1]}`);
      }
    }
  }

  return found;
};

/**
 * Drop generated pages, keeping only authored docs.
 *
 * `docs/api/`, `docs/cli/commands/`, `docs/sdk/services/`, `docs/mcp/tools/` and
 * `docs/formations-types/` are written by generators and gitignored, so whether
 * they exist depends on whether anyone has run a generator or a website build in
 * this checkout. Linting them would make the result differ between a fresh CI
 * clone and a local tree — and would report lines nobody wrote (a `{paramName}`
 * example inside a tool description, or `upload-file --file` emitted from the
 * spec's multipart route).
 *
 * The ignore rules are asked directly rather than restated here: a hand-kept
 * list of generated directories is exactly the kind of skip list that drifts.
 */
const dropGenerated = (paths) => {
  if (paths.length === 0) return paths;

  let ignored = '';
  try {
    ignored = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT,
      input: paths.join('\n'),
      encoding: 'utf-8',
    });
  } catch (error) {
    // `git check-ignore` exits 1 when nothing matched, which is not a failure.
    // Any other status (no git, not a repo) leaves every path in place: linting
    // a generated page is noisy, silently linting nothing is worse.
    if (error.status !== 1) return paths;
    ignored = error.stdout ?? '';
  }

  const skip = new Set(
    ignored
      .split('\n')
      .map((line) => {
        return line.trim();
      })
      .filter(Boolean)
  );

  return paths.filter((p) => {
    return !skip.has(p) && !skip.has(p.slice(ROOT.length));
  });
};

/** Every check, over the authored docs. Returns the violation lines. */
const runChecks = () => {
  const files = dropGenerated(collectDocs(DOCS_DIR));
  const violations = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    for (const [i, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
      for (const check of CHECKS) {
        if (check.re.test(line)) {
          violations.push(`${rel}:${i + 1}  [${check.label}]  ${line.trim()}`);
        }
      }
    }
  }

  violations.push(...checkCliFlags(files, buildCommandFlags()));

  const bodyFields = buildBodyFields();
  const serviceSegments = new Set(
    [
      ...readFileSync(
        join(CLI_DIR, 'src/generated/routes.ts'),
        'utf-8'
      ).matchAll(/serviceClass:\s*'([A-Za-z]+)'/g),
    ].map((m) => {
      // `AIProviders` -> `aiProviders`, `Agents` -> `agents`: the SDK's own
      // service-property naming.
      return m[1]
        .replace(/^[A-Z]+(?=[A-Z][a-z])/, (run) => {
          return run.toLowerCase();
        })
        .replace(/^[A-Z]/, (c) => {
          return c.toLowerCase();
        });
    })
  );

  const routeIndex = buildRouteIndex();
  violations.push(...checkSdkBodyFields(files, bodyFields, serviceSegments));
  violations.push(...checkCurlBodyFields(files, bodyFields, routeIndex));
  violations.push(...checkReferenceLinks(files, routeIndex));

  return { files, violations };
};

// Guarded so the helpers above can be imported by `tests/harness/` without the
// lint running as an import side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, violations } = runChecks();

  if (violations.length > 0) {
    console.error(`docs-lint: ${violations.length} violation(s) found:\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      '\nFix the offending docs. Runtime ID prefixes: packages/postgresdb/src/utils/publicId.ts'
    );
    process.exit(1);
  }

  console.log(`docs-lint: OK (${files.length} files scanned, no violations).`);
}
