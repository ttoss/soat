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

let cached: PermissionCatalog | null = null;

export const getPermissionCatalog = (): PermissionCatalog => {
  if (cached) return cached;

  const dir = resolvePermissionsDir();
  if (!dir) {
    log('getPermissionCatalog: permissions dir not found');
    cached = { modules: [] };
    return cached;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => {
      return f.endsWith('.json');
    })
    .sort();

  const modules: CatalogModule[] = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    if (!isPermissionFile(raw)) {
      log('getPermissionCatalog: skipping malformed file=%s', file);
      continue;
    }

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
