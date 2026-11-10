import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import {
  convertEventResources,
  hasDeny,
  insertManualReview,
  jsonLiteral,
  literal,
  type PolicyRow,
  statementsOf,
} from './eventFilterPolicyConversion';

type TriggerRow = {
  id: number;
  public_id: string;
  project_id: number;
  name: string;
  type: string;
  event_pattern: string | null;
  policy_id: number | null;
  role: string | null;
  user_policy_ids: number[] | null;
};

/** A trigger's new fields; `review` names why it was left matching nothing. */
export type TriggerConversion = {
  policyIds: string[] | 'admin';
  events: string[] | null;
  eventResources: string[] | null;
  review: string[];
};

/**
 * The creator's grant ∩ the boundary as a policy list, or `null` when no list
 * expresses it: a list is a union, so it holds only when one side contains the
 * other.
 */
const convertGrant = (args: {
  trigger: TriggerRow;
  policies: Map<number, PolicyRow>;
}): string[] | 'admin' | null => {
  const { trigger, policies } = args;
  if (trigger.role === null) return null;
  const boundary =
    trigger.policy_id === null ? undefined : policies.get(trigger.policy_id);
  const userPolicyIds = trigger.user_policy_ids ?? [];
  if (trigger.role === 'admin') {
    return boundary ? [boundary.public_id] : 'admin';
  }
  const userPolicies = userPolicyIds.flatMap((id) => {
    const row = policies.get(id);
    return row ? [row] : [];
  });
  if (!boundary) {
    return userPolicies.map((row) => {
      return row.public_id;
    });
  }
  const userDenies = userPolicies.some((row) => {
    return hasDeny(statementsOf(row));
  });
  return userPolicyIds.includes(boundary.id) && !userDenies
    ? [boundary.public_id]
    : null;
};

/**
 * One trigger's conversion. Anything a list cannot express converts to the
 * value that matches and allows nothing, and is named in `review`: no
 * conversion widens what a trigger receives or may do.
 */
export const convertTrigger = (args: {
  trigger: TriggerRow;
  policies: Map<number, PolicyRow>;
}): TriggerConversion => {
  const { trigger, policies } = args;
  const review: string[] = [];
  const grant = convertGrant(args);
  if (grant === null) {
    review.push(
      trigger.role === null
        ? 'its creator no longer exists'
        : "its creator's grant intersected with its policy is not a list of policies"
    );
  }
  const isEvent = trigger.type === 'event';
  let eventResources: string[] | null = null;
  if (isEvent && trigger.policy_id !== null) {
    eventResources = convertEventResources(
      statementsOf(policies.get(trigger.policy_id))
    );
    if (eventResources === null) {
      review.push('its policy filters events beyond a list of resources');
      eventResources = [];
    }
  }
  return {
    policyIds: grant ?? [],
    events: isEvent && trigger.event_pattern ? [trigger.event_pattern] : null,
    eventResources,
    review,
  };
};

const ALLOW_ALL = { statement: [{ effect: 'Allow', action: ['*'] }] };

const insertPolicy = (args: { publicId: string; name: string }): string => {
  return `INSERT INTO policies (public_id, name, document, created_at, updated_at)
    VALUES (${literal(args.publicId)}, ${literal(args.name)}, ${jsonLiteral(ALLOW_ALL)}, now(), now());`;
};

const insertReview = (args: {
  trigger: TriggerRow;
  review: string[];
}): string => {
  const { trigger } = args;
  const title = `Trigger '${trigger.name}' matches and allows nothing until reviewed: ${args.review.join('; ')}`;
  return insertManualReview({
    projectId: trigger.project_id,
    title,
    detail: { trigger_id: trigger.public_id, reasons: args.review },
    dedupKey: `trigger_policy_review:${trigger.public_id}`,
  });
};

const statementsFor = (args: {
  trigger: TriggerRow;
  conversion: TriggerConversion;
  reviews: boolean;
}): string[] => {
  const { trigger, conversion } = args;
  const statements: string[] = [];
  let policyIds = conversion.policyIds;
  if (policyIds === 'admin') {
    const publicId = generatePublicId(PUBLIC_ID_PREFIXES.policy);
    statements.push(
      insertPolicy({ publicId, name: `${trigger.public_id} grant` })
    );
    policyIds = [publicId];
  }
  statements.push(
    `UPDATE triggers SET policy_ids = ${jsonLiteral(policyIds)}, events = ${jsonLiteral(conversion.events)}, event_resources = ${jsonLiteral(conversion.eventResources)} WHERE id = ${trigger.id};`
  );
  if (args.reviews && conversion.review.length > 0) {
    statements.push(insertReview({ trigger, review: conversion.review }));
  }
  return statements;
};

const buildStatements = async (context: MigrationContext): Promise<string> => {
  const triggers = await context.select<TriggerRow>({
    sql: `SELECT t.id, t.public_id, t.project_id, t.name, t.type, t.event_pattern,
                 t.policy_id, u.role::text AS role, u.policy_ids AS user_policy_ids
            FROM triggers t LEFT JOIN users u ON u.id = t.created_by_user_id
           ORDER BY t.id`,
  });
  const policyRows = await context.select<PolicyRow>({
    sql: 'SELECT id, public_id, document::text AS document FROM policies',
  });
  const policies = new Map(
    policyRows.map((row) => {
      return [row.id, row];
    })
  );
  const reviews = await context.tableExists({ table: 'exception_items' });
  const updates = triggers.flatMap((trigger) => {
    const conversion = convertTrigger({ trigger, policies });
    return statementsFor({ trigger, conversion, reviews });
  });
  return [
    'ALTER TABLE triggers ADD COLUMN IF NOT EXISTS policy_ids jsonb;',
    'ALTER TABLE triggers ADD COLUMN IF NOT EXISTS events json;',
    'ALTER TABLE triggers ADD COLUMN IF NOT EXISTS event_resources json;',
    'ALTER TABLE triggers ADD COLUMN IF NOT EXISTS event_data json;',
    ...updates,
    'ALTER TABLE triggers DROP COLUMN policy_id;',
    'ALTER TABLE triggers DROP COLUMN event_pattern;',
  ].join('\n');
};

const FIRING_COLUMNS = `ALTER TABLE trigger_firings ADD COLUMN IF NOT EXISTS acted_as_principal_type varchar(255);
ALTER TABLE trigger_firings ADD COLUMN IF NOT EXISTS acted_as_principal_id varchar(255);`;

/**
 * A trigger's `policy_id` becomes `policy_ids`, the creator's grant ∩ that
 * policy, and its event filter becomes `events` and `event_resources`. One
 * statement string, so no trigger is left half moved.
 */
export const triggerPolicyIds = defineMigration({
  name: '2026-11-10-trigger-policy-ids',
  description:
    'triggers.policy_id and event_pattern become policy_ids, events and event_resources; trigger_firings gains acted_as_principal_*.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'triggers' }))) return true;
    return !(await context.columnExists({
      table: 'triggers',
      column: 'policy_id',
    }));
  },
  up: async (context) => {
    const sql = await buildStatements(context);
    const firings = await context.tableExists({ table: 'trigger_firings' });
    context.say('moving trigger policies and event filters');
    await context.run({ sql: firings ? `${sql}\n${FIRING_COLUMNS}` : sql });
  },
});
