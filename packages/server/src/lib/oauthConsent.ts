/**
 * OAuth consent — turns a user's selection on the consent screen into the
 * scopes and project-scoped IAM policy carried by the issued access token.
 *
 * The consent screen offers three tiers of granularity (see the permission
 * catalog):
 *
 * - `all`     → every action (`*`)
 * - `modules` → every action of one or more modules (`<module>:*`)
 * - `actions` → individually selected actions (`<module>:<Action>`)
 *
 * Whatever the tier, the resulting policy is always scoped to a single project
 * via the SRN `soat:<project>:*:*`.
 */
import createDebug from 'debug';

import { DomainError } from '../errors';
import type { PolicyDocument } from './iam';
import { buildSrn } from './iam';
import { listAllActions, listModuleNames } from './permissionCatalog';

const log = createDebug('soat:oauth-consent');

export type ConsentSelection =
  | { kind: 'all' }
  | { kind: 'modules'; modules: string[] }
  | { kind: 'actions'; actions: string[] };

const uniqueSorted = (values: string[]): string[] => {
  return Array.from(new Set(values)).sort();
};

/**
 * Validates a consent selection against the permission catalog and returns the
 * granted scope patterns. Throws `VALIDATION_FAILED` for unknown or empty
 * selections.
 */
export const buildConsentScopes = (selection: ConsentSelection): string[] => {
  if (selection.kind === 'all') {
    return ['*'];
  }

  if (selection.kind === 'modules') {
    const modules = uniqueSorted(selection.modules);
    if (modules.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Select at least one module to grant.'
      );
    }
    const known = listModuleNames();
    const unknown = modules.filter((m) => {
      return !known.has(m);
    });
    if (unknown.length > 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Unknown module(s): ${unknown.join(', ')}.`,
        { unknown }
      );
    }
    return modules.map((m) => {
      return `${m}:*`;
    });
  }

  const actions = uniqueSorted(selection.actions);
  if (actions.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Select at least one permission to grant.'
    );
  }
  const known = listAllActions();
  const unknown = actions.filter((a) => {
    return !known.has(a);
  });
  if (unknown.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Unknown permission(s): ${unknown.join(', ')}.`,
      { unknown }
    );
  }
  return actions;
};

/**
 * Builds the project-scoped IAM policy document for a consent grant. The
 * actions come from {@link buildConsentScopes}; the resource is always the
 * single chosen project (`soat:<project>:*:*`).
 */
export const buildConsentPolicy = (args: {
  projectPublicId: string;
  selection: ConsentSelection;
}): PolicyDocument => {
  log(
    'buildConsentPolicy: project=%s kind=%s',
    args.projectPublicId,
    args.selection.kind
  );

  const action = buildConsentScopes(args.selection);
  const resource = buildSrn({
    projectPublicId: args.projectPublicId,
    resourceType: '*',
    resourceId: '*',
  });

  return {
    statement: [{ effect: 'Allow', action, resource: [resource] }],
  };
};
