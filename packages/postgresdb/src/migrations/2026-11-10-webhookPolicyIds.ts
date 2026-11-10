import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

import {
  convertEventResources,
  insertManualReview,
  jsonLiteral,
  type PolicyRow,
  statementsOf,
} from './eventFilterPolicyConversion';

type WebhookRow = {
  id: number;
  public_id: string;
  project_id: number;
  name: string;
  policy_id: number | null;
};

/**
 * A webhook records no creator, so no grant is known to intersect with its
 * filter: `policy_ids` converts to none, which receives nothing, and every
 * webhook is filed for review. No conversion widens what one receives.
 */
const NO_CREATOR = 'no creator is recorded whose grant it could carry';

const statementsFor = (args: {
  webhook: WebhookRow;
  policies: Map<number, PolicyRow>;
  reviews: boolean;
}): string[] => {
  const { webhook } = args;
  const review = [NO_CREATOR];
  let eventResources: string[] | null = null;
  if (webhook.policy_id !== null) {
    eventResources = convertEventResources(
      statementsOf(args.policies.get(webhook.policy_id))
    );
    if (eventResources === null) {
      review.push('its policy filters events beyond a list of resources');
      eventResources = [];
    }
  }
  const statements = [
    `UPDATE webhooks SET policy_ids = '[]', event_resources = ${jsonLiteral(eventResources)} WHERE id = ${webhook.id};`,
  ];
  if (args.reviews) {
    statements.push(
      insertManualReview({
        projectId: webhook.project_id,
        title: `Webhook '${webhook.name}' receives nothing until reviewed: ${review.join('; ')}`,
        detail: { webhook_id: webhook.public_id, reasons: review },
        dedupKey: `webhook_policy_review:${webhook.public_id}`,
      })
    );
  }
  return statements;
};

const buildStatements = async (context: MigrationContext): Promise<string> => {
  const webhooks = await context.select<WebhookRow>({
    sql: 'SELECT id, public_id, project_id, name, policy_id FROM webhooks ORDER BY id',
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
  return [
    'ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS policy_ids jsonb;',
    'ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS event_resources json;',
    'ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS event_data json;',
    ...webhooks.flatMap((webhook) => {
      return statementsFor({ webhook, policies, reviews });
    }),
    'ALTER TABLE webhooks DROP COLUMN policy_id;',
  ].join('\n');
};

/**
 * A webhook's `policy_id` filter becomes `event_resources`, and it gains
 * `policy_ids`, `event_data`. One statement string, so no webhook is left half
 * moved.
 */
export const webhookPolicyIds = defineMigration({
  name: '2026-11-10-webhook-policy-ids',
  description:
    'webhooks.policy_id becomes event_resources; webhooks gain policy_ids and event_data.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'webhooks' }))) return true;
    return !(await context.columnExists({
      table: 'webhooks',
      column: 'policy_id',
    }));
  },
  up: async (context) => {
    const sql = await buildStatements(context);
    context.say('moving webhook policies and event filters');
    await context.run({ sql });
  },
});
