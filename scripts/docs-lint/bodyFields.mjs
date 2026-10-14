import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonical,
  CLI_MANIFEST,
  joinContinuations,
  OPENAPI_DIR,
  ROOT,
  sliceArray,
} from './common.mjs';

// ── Check 5: documented SDK / curl body fields must exist ───────────────────
//
// Check 4 covers CLI tabs only, and every module example ships three languages,
// so guarding one leaves two thirds unguarded and a reader on the SDK tab with
// nothing that works.
//
// Scope is deliberately the top-level fields of a JSON body: the CLI manifest
// flattens a body to its top-level flags, so nested schemas are not available
// from the same static source.

/** operationId -> Set of canonical top-level body field names. */
export const buildBodyFields = () => {
  const manifest = readFileSync(CLI_MANIFEST, 'utf-8');
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
export const buildRouteIndex = () => {
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

const QUOTES = new Set(['"', "'", '`']);
const DEPTH_CHANGE = { '{': 1, '[': 1, '}': -1, ']': -1 };

/**
 * Skip the string literal opening at `start` and answer where it closes. A
 * quoted string *is* a key when a colon follows it — which is how every JSON
 * key is spelled — so at the top level it is recorded as one.
 */
const readQuoted = (args) => {
  const { text, start, depth, entries } = args;
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') i++;
    i++;
  }
  const after = text.slice(i + 1).match(/^\s*:/);
  if (depth === 1 && after) {
    const name = text.slice(start + 1, i);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      entries.push({ key: name, valueStart: i + 1 + after[0].length });
    }
  }
  return i;
};

/** An unquoted `key:` at the top level of the object. */
const pushBareKey = (args) => {
  const { text, i, entries } = args;
  const key = text.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
  if (key && /[{,\s]/.test(text[i - 1] ?? '')) {
    entries.push({ key: key[1], valueStart: i + key[0].length });
  }
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
    // and any prose containing a colon becomes a key.
    if (QUOTES.has(ch)) {
      i = readQuoted({ text, start: i, depth, entries });
      continue;
    }

    const change = DEPTH_CHANGE[ch] ?? 0;
    depth += change;
    if (change < 0 && depth === 0) return entries;
    if (change === 0 && depth === 1) pushBareKey({ text, i, entries });
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

/**
 * The SDK's service property names, read from the manifest: `AIProviders` ->
 * `aiProviders`, `Agents` -> `agents`.
 */
export const buildServiceSegments = () => {
  return new Set(
    [
      ...readFileSync(CLI_MANIFEST, 'utf-8').matchAll(
        /serviceClass:\s*'([A-Za-z]+)'/g
      ),
    ].map((m) => {
      return m[1]
        .replace(/^[A-Z]+(?=[A-Z][a-z])/, (run) => {
          return run.toLowerCase();
        })
        .replace(/^[A-Z]/, (c) => {
          return c.toLowerCase();
        });
    })
  );
};

/** The violations one `<client>.<service>.<operation>({ ... })` call carries. */
const sdkCallViolations = (args) => {
  const { text, call, where, bodyFields } = args;
  const operationId = call[2];
  const allowed = bodyFields.get(operationId);
  if (!allowed) {
    return [`${where}  [unknown SDK operation]  ${call[1]}.${operationId}`];
  }
  // An empty set means the manifest describes no body for this operation —
  // `upload-file` is `multipart/form-data`, which the flag generator does not
  // flatten. That is "unknown", not "nothing allowed", so there is nothing to
  // check against.
  if (allowed.size === 0) return [];

  // `body` among this call's own argument keys. A call with no body (a GET)
  // has nothing to check.
  const callArgs = objectEntriesAt(text, call.index + call[0].length - 1);
  const body = callArgs?.find((entry) => {
    return entry.key === 'body';
  });
  const keys = body ? objectKeysAt(text, body.valueStart) : null;

  return (keys ?? [])
    .filter((key) => {
      return !allowed.has(canonical(key));
    })
    .map((key) => {
      return `${where}  [unknown SDK body field]  ${operationId} body.${key}`;
    });
};

export const checkSdkBodyFields = (files, bodyFields, serviceSegments) => {
  const found = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const text = readFileSync(file, 'utf-8');

    for (const call of text.matchAll(
      /\b[A-Za-z_$][\w$]*\.([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)\(\{/g
    )) {
      if (!serviceSegments.has(call[1])) continue;
      const where = `${rel}:${text.slice(0, call.index).split('\n').length}`;
      found.push(...sdkCallViolations({ text, call, where, bodyFields }));
    }
  }

  return found;
};

/** The violations one curl command's `-d` payload carries. */
const curlViolations = (args) => {
  const { text, where, bodyFields, routeIndex } = args;
  const payload = text.match(/-d\s+'([\s\S]*)'/);
  const url = text.match(/https?:\/\/[^\s'"]+/);
  if (!payload || !url) return [];

  const pathname = url[0].replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const method = (text.match(/-X\s+([A-Z]+)/)?.[1] ?? 'POST').toLowerCase();
  const route = routeIndex.find((r) => {
    return r.method === method && r.re.test(pathname);
  });
  const allowed = route && bodyFields.get(route.operationId);
  if (!allowed || allowed.size === 0) return [];

  // A payload carrying a shell variable or a `<placeholder>` is not JSON;
  // its keys are still readable structurally.
  return (objectKeysAt(payload[1], 0) ?? [])
    .filter((key) => {
      return !allowed.has(canonical(key));
    })
    .map((key) => {
      return `${where}  [unknown curl body field]  ${route.operationId} body.${key}`;
    });
};

export const checkCurlBodyFields = (files, bodyFields, routeIndex) => {
  const found = [];

  for (const file of files) {
    const rel = file.slice(ROOT.length);
    const lines = readFileSync(file, 'utf-8').split('\n');

    // The URL and the `-d` payload of one curl are seen together.
    for (const { text, line } of joinContinuations(lines, /^\s*curl\s/)) {
      found.push(
        ...curlViolations({
          text,
          where: `${rel}:${line}`,
          bodyFields,
          routeIndex,
        })
      );
    }
  }

  return found;
};
