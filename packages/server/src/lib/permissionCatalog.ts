/**
 * Permission catalog — the source of truth for the OAuth consent screen.
 *
 * Reads the per-module permission definitions in `src/permissions/*.json` and
 * exposes them as a structured catalog of modules and their granular actions.
 * The consent screen renders this catalog as a three-tier selection:
 *
 * - all permissions    → `*`
 * - per-module          → `<module>:*`
 * - granular per-action → `<module>:<Action>`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import createDebug from 'debug';

const log = createDebug('soat:permission-catalog');

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export type CatalogAction = {
  action: string;
  description: string;
};

export type CatalogModule = {
  module: string;
  actions: CatalogAction[];
};

export type PermissionCatalog = {
  modules: CatalogModule[];
};

type PermissionFile = {
  module: string;
  operations: Array<{
    operationId: string;
    action: string;
    description?: string;
  }>;
};

const resolvePermissionsDir = (): string | null => {
  // In tests (ts-jest) __dirname is src/lib → permissions live at ../permissions.
  // In the production bundle __dirname is dist → permissions are copied alongside.
  const candidates = [
    path.resolve(__dirname, '../permissions'),
    path.resolve(__dirname, 'permissions'),
  ];
  return (
    candidates.find((c) => {
      return fs.existsSync(c);
    }) ?? null
  );
};

const isPermissionFile = (value: unknown): value is PermissionFile => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.module === 'string' && Array.isArray(v.operations);
};

/**
 * Every well-formed permission file on disk, in filename order.
 *
 * A file that cannot be parsed is skipped rather than thrown from: the catalog
 * backs the consent screen and the policy-authoring typo check, and both are
 * documented to degrade to "no catalog" rather than take a request down. The
 * `isPermissionFile` guard below already expressed that intent for a file whose
 * *shape* is wrong; a file whose JSON is unreadable — or a `.json` that is not
 * a permission file at all — reached `JSON.parse` first and threw past it.
 */
const readPermissionFiles = (): PermissionFile[] => {
  const dir = resolvePermissionsDir();
  if (!dir) {
    log('readPermissionFiles: permissions dir not found');
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => {
      return f.endsWith('.json');
    })
    .sort();

  const parsed: PermissionFile[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    } catch (error) {
      log(
        'readPermissionFiles: skipping unreadable file=%s error=%o',
        file,
        error
      );
      continue;
    }
    if (!isPermissionFile(raw)) {
      log('readPermissionFiles: skipping malformed file=%s', file);
      continue;
    }
    parsed.push(raw);
  }
  return parsed;
};

let cached: PermissionCatalog | null = null;

export const getPermissionCatalog = (): PermissionCatalog => {
  if (cached) return cached;

  const modules: CatalogModule[] = [];

  for (const raw of readPermissionFiles()) {
    const seen = new Set<string>();
    const actions: CatalogAction[] = [];
    for (const op of raw.operations) {
      if (seen.has(op.action)) continue;
      seen.add(op.action);
      actions.push({ action: op.action, description: op.description ?? '' });
    }

    modules.push({ module: raw.module, actions });
  }

  modules.sort((a, b) => {
    return a.module.localeCompare(b.module);
  });
  log('getPermissionCatalog: loaded modules=%d', modules.length);

  cached = { modules };
  return cached;
};

let operationActions: Map<string, string> | null = null;

/**
 * The IAM action an operation is enforced with, keyed by its OpenAPI
 * `operationId` — the same mapping the route handlers pass to `isAllowed`.
 *
 * This is what lets the `soat` tool surface evaluate `boundary_policy` against
 * the action an author can actually write (`documents:UpdateDocument`) rather
 * than the tool's own kebab-case name (`update-document`). Only 9 of 267
 * operations declare `x-iam-action` in their spec, and a boundary containing a
 * kebab name is rejected by `validatePolicyActions` — so without this lookup a
 * `Deny` boundary matched nothing at all and failed open (#1070).
 *
 * Returns `undefined` for operations that are unauthorized by design (login,
 * bootstrap, `users/me`, token-credentialed upload, the ingestion callback).
 */
export const getActionForOperation = (
  operationId: string
): string | undefined => {
  if (!operationActions) {
    operationActions = new Map();
    for (const file of readPermissionFiles()) {
      for (const op of file.operations) {
        operationActions.set(op.operationId, op.action);
      }
    }
    log('getActionForOperation: indexed operations=%d', operationActions.size);
  }
  return operationActions.get(operationId);
};

export const listAllActions = (): Set<string> => {
  const actions = new Set<string>();
  for (const mod of getPermissionCatalog().modules) {
    for (const action of mod.actions) {
      actions.add(action.action);
    }
  }
  return actions;
};

export const listModuleNames = (): Set<string> => {
  return new Set(
    getPermissionCatalog().modules.map((m) => {
      return m.module;
    })
  );
};
