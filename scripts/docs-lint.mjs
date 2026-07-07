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
  // Only flag `:camelCase` route-style path params, not every colon.
  { label: 'camelCase path param (use snake_case)', re: /:[a-z]+[A-Z][a-zA-Z]*/ },
  { label: 'stale action: documents:SearchDocuments', re: /documents:SearchDocuments|\bSearchDocuments\b/ },
  { label: 'stale soat-tool action: search-documents', re: /\bsearch-documents\b/ },
  {
    label: 'wrong public-ID prefix (see publicId.ts)',
    re: /\b(agt_|trc_|actr_|act_[0-9A-Za-z]|tol_|fl_[0-9A-Za-z]|af_[0-9A-Za-z]|afr_|afo_|prj_|usr_|cht_|fil_|me_[0-9A-Za-z])/,
  },
];

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

if (violations.length > 0) {
  console.error(`docs-lint: ${violations.length} violation(s) found:\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nFix the offending docs. Runtime ID prefixes: packages/postgresdb/src/utils/publicId.ts'
  );
  process.exit(1);
}

console.log(`docs-lint: OK (${files.length} files scanned, no violations).`);
