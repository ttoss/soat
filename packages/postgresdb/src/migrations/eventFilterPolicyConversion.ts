/**
 * What an event-filter `policy_id` becomes in a subscriber's `event_resources`,
 * shared by the trigger and webhook migrations so both convert one filter the
 * same way.
 */

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';

type Statement = {
  effect?: string;
  action?: string[];
  resource?: string[];
  condition?: unknown;
};
export type PolicyRow = { id: number; public_id: string; document: string };

export const statementsOf = (policy: PolicyRow | undefined): Statement[] => {
  if (!policy) return [];
  const document = JSON.parse(policy.document) as { statement?: Statement[] };
  return document.statement ?? [];
};

export const hasDeny = (statements: Statement[]): boolean => {
  return statements.some((statement) => {
    return statement.effect === 'Deny';
  });
};

/** An action pattern that could match a dotted event type, other than `*`. */
const isEventGlob = (action: string): boolean => {
  return action !== '*' && !action.includes(':');
};

/**
 * The resources an event-filter policy let through, or `null` when its
 * statements say more than a resource list can (a `Deny`, a condition, an
 * action narrowing event types).
 */
export const convertEventResources = (
  statements: Statement[]
): string[] | null => {
  const resources: string[] = [];
  for (const statement of statements) {
    if (statement.effect !== 'Allow' || statement.condition) return null;
    const actions = statement.action ?? [];
    if (actions.some(isEventGlob)) return null;
    if (actions.includes('*')) resources.push(...(statement.resource ?? ['*']));
  }
  return [...new Set(resources)];
};

export const literal = (value: string): string => {
  return `'${value.replaceAll("'", "''")}'`;
};

export const jsonLiteral = (value: unknown): string => {
  return value === null ? 'NULL' : literal(JSON.stringify(value));
};

/** Files the open `manual` exception that names a resource left for review. */
export const insertManualReview = (args: {
  projectId: number;
  title: string;
  detail: Record<string, unknown>;
  dedupKey: string;
}): string => {
  return `INSERT INTO exception_items (public_id, project_id, status, severity, kind, title, detail, dedup_key, occurrence_count, last_seen_at, created_at, updated_at)
    VALUES (${literal(generatePublicId(PUBLIC_ID_PREFIXES.exception))}, ${args.projectId}, 'open', 'warning', 'manual', ${literal(args.title)}, ${jsonLiteral(args.detail)}, ${literal(args.dedupKey)}, 1, now(), now(), now());`;
};
