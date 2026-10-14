#!/usr/bin/env node
// Docs drift guardrail. Greps the website docs for classes of rot that would
// otherwise re-accumulate silently:
//
//   1. Forbidden TypeScript casts in SDK examples.
//   2. camelCase path params in URL templates — the contract is snake_case.
//   3. A stale-term denylist: renamed actions and wrong public-ID prefixes.
//   4. A documented `soat <cmd> --flag` naming no real CLI parameter.
//   5. A documented SDK or curl request-body field naming no real property.
//   6. An endpoint mention not linked to its generated reference page, and any
//      /docs/api/ link addressing a page no operation generates.
//   7. A doc without a non-empty, unique `description` front matter field.
//   8. Two REST operations sharing one description — check 7 for the pages it
//      cannot see, read from the specs the pages are generated from.
//
// Checks 4 and 5 are existence checks against the in-repo sources of truth,
// covering all three tabs every module example ships: guarding one language
// leaves a broken example on either of the other two.
//
// Usage: node scripts/docs-lint.mjs

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBodyFields,
  buildRouteIndex,
  buildServiceSegments,
  checkCurlBodyFields,
  checkSdkBodyFields,
} from './docs-lint/bodyFields.mjs';
import { buildCommandFlags, checkCliFlags } from './docs-lint/cliFlags.mjs';
import { ROOT } from './docs-lint/common.mjs';
import {
  buildOperationDescriptions,
  checkDescriptions,
  checkOperationDescriptions,
} from './docs-lint/descriptions.mjs';
import { checkReferenceLinks } from './docs-lint/referenceLinks.mjs';

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
  // keys follow the auto-populated `sessionId`/`actorId` spelling), and an SRN
  // segment, which is not a path param either: three resource types
  // (`aiProvider`, `ingestionRule`, `apiKey`) are spelled camelCase in the
  // published policy vocabulary, and a doc that shows the working spelling is
  // the point rather than the drift.
  {
    label: 'camelCase path param (use snake_case)',
    re: /(?<!\{\{(?:context|secret)|\bsrn:[A-Za-z0-9_*<>{}-]{1,64}):[a-z]+[A-Z][a-zA-Z]*/,
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
  // Fields no endpoint accepts. `\btool_ids\b` does not match
  // `active_tool_ids`, still a real field, since `_` is a word character. The
  // `tools` shorthand gets no entry: too common to denylist, and a documented
  // `--tools` flag is already caught by the CLI-flag check below.
  {
    label: "removed field: 'tool_ids' (agents attach tools via tool_bindings)",
    re: /\btool_ids\b/,
  },
  // Stored shapes nothing reads: the camelCase spellings of
  // step-rule keys, a forced tool's name, and an http tool's body mode. The wire
  // — and documented — spellings are tool_choice / active_tool_ids / tool_name /
  // body_mode.
  {
    label: 'retired camelCase spelling (use the snake_case wire name)',
    re: /\b(toolChoice|activeToolIds|toolName|bodyMode)\b/,
  },
  // The SDK's `error` is the raw API body, so the code lives one level down at
  // `error.error.code`. A doc reading `error.code` prints `undefined` for the
  // one value the step exists to show, and the tutorials runner executes only
  // the CLI tab so it cannot catch it. `[\w$]*` cannot span a dot, so the
  // correct `x.error.code` never matches.
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

  let ignored;
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
  const serviceSegments = buildServiceSegments();

  const routeIndex = buildRouteIndex();
  violations.push(...checkSdkBodyFields(files, bodyFields, serviceSegments));
  violations.push(...checkCurlBodyFields(files, bodyFields, routeIndex));
  violations.push(...checkReferenceLinks(files, routeIndex));
  violations.push(
    ...checkDescriptions(
      files.map((file) => {
        return {
          rel: file.slice(ROOT.length),
          text: readFileSync(file, 'utf-8'),
        };
      })
    )
  );

  violations.push(...checkOperationDescriptions(buildOperationDescriptions()));

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
