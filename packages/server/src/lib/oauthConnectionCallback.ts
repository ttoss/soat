import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { type OauthClientRow, resolveOauthClient } from './oauthClients';
import {
  connectionIncludes,
  hashState,
  mapOauthConnection,
  type OauthConnectionRow,
  oauthConnections,
  tokenColumns,
} from './oauthConnections';
import { requestTokens, type TokenSet } from './oauthTokenEndpoint';
import { decryptValue } from './secrets';

const log = createDebug('soat:oauth-connections');

const callbackFailed = (message: string) => {
  return new DomainError('OAUTH_CALLBACK_FAILED', message);
};

/**
 * Claims the pending authorization `state` names, once: a replayed or expired
 * state matches no row.
 */
const claimState = async (args: { state: string; now: Date }) => {
  const stateHash = hashState(args.state);
  const row = (await db.OauthConnection.findOne({
    where: { stateHash },
    include: connectionIncludes(),
  })) as OauthConnectionRow | null;
  if (!row) return null;
  const pending = {
    codeVerifier: row.encryptedCodeVerifier
      ? decryptValue(row.encryptedCodeVerifier)
      : null,
    redirectUri: row.redirectUri,
    returnUrl: row.returnUrl,
    expired: !row.stateExpiresAt || row.stateExpiresAt <= args.now,
  };
  const [claimed] = await db.OauthConnection.update(
    {
      stateHash: null,
      stateExpiresAt: null,
      encryptedCodeVerifier: null,
      returnUrl: null,
    },
    { where: { id: row.id, stateHash } }
  );
  return claimed === 1 && !pending.expired ? { row, pending } : null;
};

export type OauthCallbackOutcome = {
  connection: ReturnType<typeof mapOauthConnection>;
  returnUrl: string | null;
  failure: DomainError | null;
};

const recordFailure = async (args: {
  row: OauthConnectionRow;
  failure: DomainError;
}) => {
  await args.row.update({
    ...(args.row.status === 'connected' ? {} : { status: 'disconnected' }),
    error: { code: args.failure.code, message: args.failure.message },
  });
};

const exchangeCode = async (args: {
  code?: string;
  error?: string;
  errorDescription?: string;
  client: OauthClientRow;
  pending: { codeVerifier: string | null; redirectUri: string | null };
  now: Date;
}): Promise<{ tokens: TokenSet } | { failure: DomainError }> => {
  if (args.error || !args.code) {
    const detail = args.errorDescription ? ` (${args.errorDescription})` : '';
    return {
      failure: callbackFailed(
        `The provider refused the authorization: ${args.error ?? 'no code'}${detail}.`
      ),
    };
  }
  const result = await requestTokens({
    client: await resolveOauthClient(args.client),
    params: {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.pending.redirectUri ?? '',
      ...(args.pending.codeVerifier
        ? { code_verifier: args.pending.codeVerifier }
        : {}),
    },
    now: args.now,
  });
  if (result.ok) return { tokens: result.tokens };
  return {
    failure: callbackFailed(
      `The token endpoint refused the authorization code: ${result.error}.`
    ),
  };
};

/** The provider's redirect: exchanges the code and stores the tokens. */
export const completeOauthConnection = async (args: {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
  now?: Date;
}): Promise<OauthCallbackOutcome> => {
  const now = args.now ?? new Date();
  const claimed = args.state
    ? await claimState({ state: args.state, now })
    : null;
  if (!claimed) {
    log('completeOauthConnection: unknown, used or expired state');
    throw callbackFailed(
      'The authorization state is unknown, already used or expired; start the connection again.'
    );
  }
  const { row, pending } = claimed;
  const client = row.oauthClient as OauthClientRow;

  const exchanged = await exchangeCode({ ...args, client, pending, now });
  if ('failure' in exchanged) {
    await recordFailure({ row, failure: exchanged.failure });
  } else {
    await row.update({
      ...tokenColumns(exchanged.tokens),
      status: 'connected',
      grantedScopes: exchanged.tokens.scopes ?? client.scopes,
      connectedAt: now,
      error: null,
    });
  }
  const failure = 'failure' in exchanged ? exchanged.failure : null;
  log(
    'completeOauthConnection: connection=%s failed=%s',
    row.publicId,
    !!failure
  );
  return {
    connection: mapOauthConnection(await oauthConnections.reload(row)),
    returnUrl: pending.returnUrl,
    failure,
  };
};
