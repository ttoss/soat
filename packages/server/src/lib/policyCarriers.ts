import { db } from '../db';

/**
 * Every resource besides agents whose `policy_ids` column names the policies
 * it acts or reads under; agents also carry them in archived versions. A
 * policy one names cannot be deleted, and an edit to it is checked in its
 * project.
 */
export const DIRECT_POLICY_CARRIERS: {
  triggers: () => (typeof db)['Trigger'];
  webhooks: () => (typeof db)['Webhook'];
} = {
  triggers: () => {
    return db.Trigger;
  },
  webhooks: () => {
    return db.Webhook;
  },
};
