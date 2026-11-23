import createDebug from 'debug';

import type { Transaction } from './dbTransaction';
import {
  mapOauthConnection,
  type OauthConnectionRow,
  oauthConnections,
} from './oauthConnections';
import { emitLoadedRecordEvent } from './recordEvents';
import type { SoatEventTypeFor } from './soatEvents';

const log = createDebug('soat:oauth-connections');

/**
 * The one writer of a connection's `connected` and `disconnected` status, so
 * every such move announces itself (pinned by
 * `tests/harness/oauthConnectionStatusChokepoint.test.mjs`).
 */

const announce = (args: {
  type: SoatEventTypeFor<'oauth_connection'>;
  row: OauthConnectionRow;
}): Promise<void> => {
  log('announce: type=%s connection=%s', args.type, args.row.publicId);
  return emitLoadedRecordEvent({
    type: args.type,
    projectId: args.row.projectId,
    resourceType: 'oauth_connection',
    resourceId: args.row.publicId,
    load: async () => {
      return mapOauthConnection(await oauthConnections.reload(args.row));
    },
  });
};

/** A completed authorization: announced every time, re-authorizations too. */
export const markOauthConnectionConnected = async (args: {
  row: OauthConnectionRow;
  columns: Record<string, unknown>;
}): Promise<void> => {
  await args.row.update({ ...args.columns, status: 'connected', error: null });
  await announce({ type: 'oauth_connections.connected', row: args.row });
};

/**
 * Announced only when the status moves, after `transaction` commits: a
 * rolled-back write moved nothing.
 */
export const markOauthConnectionDisconnected = async (args: {
  row: OauthConnectionRow;
  error: { code: string; message: string };
  transaction: Transaction | null;
}): Promise<void> => {
  const moved = args.row.status !== 'disconnected';
  log(
    'markOauthConnectionDisconnected: connection=%s moved=%s',
    args.row.publicId,
    moved
  );
  await args.row.update(
    { status: 'disconnected', error: args.error },
    { transaction: args.transaction ?? undefined }
  );
  if (!moved) return;
  const emit = () => {
    return announce({ type: 'oauth_connections.disconnected', row: args.row });
  };
  if (!args.transaction) {
    await emit();
    return;
  }
  args.transaction.afterCommit(() => {
    void emit();
  });
};
