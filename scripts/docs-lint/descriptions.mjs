import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPENAPI_DIR } from './common.mjs';

// ── Check 7: every doc has a non-empty, unique description ──────────────────
//
// It becomes the snippet search engines and AI crawlers quote. Docusaurus
// silently falls back to the site tagline when it is missing, so an undescribed
// page still builds — it just competes with every other undescribed page. The
// uniqueness rule catches the copy-paste variant.

/**
 * Extract the `description` front matter value from a doc's source, or null
 * when there is no front matter, no description field, or an empty value.
 * Surrounding single or double quotes are stripped, mirroring YAML.
 */
export const frontMatterDescription = (text) => {
  const frontMatter = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontMatter) return null;
  const field = frontMatter[1].match(/^description:[ \t]*(.*)$/m);
  if (!field) return null;
  const value = field[1]
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
  return value === '' ? null : value;
};

/**
 * Check every authored doc for a missing or duplicated description.
 * Takes `{ rel, text }` entries so the rule stays a pure function of content.
 */
export const checkDescriptions = (entries) => {
  const found = [];
  const byDescription = new Map();

  for (const entry of entries) {
    const description = frontMatterDescription(entry.text);
    if (description === null) {
      found.push(`${entry.rel}  [missing description front matter]`);
      continue;
    }
    const holders = byDescription.get(description) ?? [];
    holders.push(entry.rel);
    byDescription.set(description, holders);
  }

  for (const [description, holders] of byDescription) {
    if (holders.length < 2) continue;
    for (const rel of holders) {
      found.push(
        `${rel}  [duplicate description]  shared with ${holders
          .filter((other) => {
            return other !== rel;
          })
          .join(', ')}: "${description}"`
      );
    }
  }

  return found;
};

// ── Check 8: every REST operation description is unique ─────────────────────
//
// Check 7 enforces this on authored pages, but the reference pages under
// `docs/api/` are generated and gitignored, so `dropGenerated` drops them —
// and their front matter `description` is copied from the operation. Four
// operations sharing one sentence therefore ship four pages competing for the
// same snippet, invisibly. The specs are the committed source of truth, so
// reading them instead of the generated pages keeps the result identical in a
// fresh CI clone and a local tree that has run a generator.

/**
 * The operation-level field on `lines[index]`, or null when the line carries
 * none. Block scalars are resolved here so the caller stays a state machine.
 */
const readOperationField = (lines, index) => {
  const line = lines[index];

  const operationId = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
  if (operationId) return { key: 'operationId', value: operationId[1] };

  const field = line.match(/^ {6}(summary|description):[ \t]*(.*)$/);
  if (!field) return null;

  const style = field[2].trim();
  return {
    key: field[1],
    value: /^[|>][-+]?$/.test(style)
      ? readBlockScalarHead(lines, index + 1, style.startsWith('>'))
      : unquote(field[2]),
  };
};

/**
 * Every documented operation in one spec as `{ spec, operationId, description }`.
 *
 * Line-based like `buildRouteIndex`, and indentation is the structure: an
 * operation's own keys sit at six spaces. Tracking the enclosing `paths:` block
 * is what keeps a schema property's `description` — same indentation, under
 * `components:` — out of the result.
 */
const readSpecOperations = (spec, lines) => {
  const operations = [];
  let inPaths = false;
  let current = null;

  /** Close the operation being read, keeping it only if it named itself. */
  const flush = () => {
    const description =
      current?.operationId && (current.description || current.summary);
    if (description) {
      operations.push({ spec, operationId: current.operationId, description });
    }
    current = null;
  };

  for (const [index, line] of lines.entries()) {
    if (/^\S/.test(line)) {
      flush();
      inPaths = /^paths:/.test(line);
    } else if (!inPaths) {
      continue;
    } else if (/^ {4}(get|post|put|patch|delete):\s*$/.test(line)) {
      flush();
      current = { operationId: null, summary: null, description: null };
    } else if (/^ {2}\/\S*:\s*$/.test(line)) {
      flush();
    } else if (current) {
      const field = readOperationField(lines, index);
      if (field) current[field.key] = field.value;
    }
  }

  flush();
  return operations;
};

/**
 * Every documented operation across the v1 specs. The description falls back to
 * the summary because that is what the OpenAPI plugin writes into the page's
 * front matter when an operation has no description of its own.
 */
export const buildOperationDescriptions = () => {
  const operations = [];

  for (const entry of readdirSync(OPENAPI_DIR)) {
    if (!entry.endsWith('.yaml')) continue;
    operations.push(
      ...readSpecOperations(
        entry.replace(/\.yaml$/, ''),
        readFileSync(join(OPENAPI_DIR, entry), 'utf-8').split('\n')
      )
    );
  }

  return operations;
};

/**
 * The first logical line of the block scalar starting at `from`.
 *
 * The first logical line, not the whole block, because that is what ships: the
 * OpenAPI plugin writes only it into the page's front matter, so two operations
 * whose descriptions diverge only later still put the same sentence in front of
 * a crawler. Which physical lines make it up is YAML's own rule — a folded
 * (`>`) block joins them until a blank line, a literal (`|`) block keeps each
 * newline, so its first line stands alone. Matching that split is what took the
 * reader from 177 to all 283 generated pages reproduced exactly.
 */
const readBlockScalarHead = (lines, from, folded) => {
  const body = [];
  let base = null;

  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      if (body.length > 0) break;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < 8) break;
    // A more-indented line inside a folded block is not folded: YAML keeps its
    // newline, so it starts a line of its own. `api-keys.yaml` relies on this to
    // hang wrapped continuations under a bullet.
    if (base !== null && indent > base) break;
    base ??= indent;
    body.push(line.trim());
    if (!folded) break;
  }

  return body.join(' ');
};

/** A YAML scalar with its surrounding quotes removed. */
const unquote = (value) => {
  return value
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .trim();
};

/**
 * Report every operation whose description another operation repeats. Pure over
 * the entries so the rule is testable without the specs on disk.
 */
export const checkOperationDescriptions = (operations) => {
  const found = [];
  const byDescription = new Map();

  for (const operation of operations) {
    const holders = byDescription.get(operation.description) ?? [];
    holders.push(operation);
    byDescription.set(operation.description, holders);
  }

  for (const [description, holders] of byDescription) {
    if (holders.length < 2) continue;
    for (const operation of holders) {
      found.push(
        `${operation.spec}.yaml  [duplicate operation description]  ${
          operation.operationId
        } shared with ${holders
          .filter((other) => {
            return other !== operation;
          })
          .map((other) => {
            return `${other.spec}.yaml ${other.operationId}`;
          })
          .join(', ')}: "${description}"`
      );
    }
  }

  return found;
};
