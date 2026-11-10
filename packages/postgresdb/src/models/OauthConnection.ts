import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Actor } from './Actor';
import { OauthProviderClient } from './OauthProviderClient';
import { Project } from './Project';

export const OAUTH_CONNECTION_STATUSES = [
  'pending',
  'connected',
  'disconnected',
] as const;

export type OauthConnectionStatus = (typeof OAUTH_CONNECTION_STATUSES)[number];

/**
 * One actor's grant at a provider through an `OauthProviderClient`. Every
 * token and the PKCE verifier are ciphertext; `stateHash` is the SHA-256 of
 * the pending authorization's `state`.
 */
@Table({
  tableName: 'oauth_connections',
  indexes: [
    {
      name: 'oauth_connections_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'oauth_connections_client_actor_unique',
      unique: true,
      fields: ['oauth_client_id', 'actor_id'],
    },
    {
      name: 'oauth_connections_state_hash_unique',
      unique: true,
      fields: ['state_hash'],
    },
  ],
  hooks: {
    beforeValidate: (instance: OauthConnection) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.oauthConnection
        );
      }
    },
  },
})
export class OauthConnection extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  @ForeignKey(() => {
    return OauthProviderClient;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare oauthClientId: number;

  @BelongsTo(
    () => {
      return OauthProviderClient;
    },
    { onDelete: 'CASCADE' }
  )
  declare oauthClient: OauthProviderClient;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare actorId: number;

  @BelongsTo(
    () => {
      return Actor;
    },
    { onDelete: 'CASCADE' }
  )
  declare actor: Actor;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare status: OauthConnectionStatus;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare stateHash: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare stateExpiresAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare encryptedCodeVerifier: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare redirectUri: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare returnUrl: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare encryptedAccessToken: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare encryptedRefreshToken: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare accessTokenExpiresAt: Date | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare grantedScopes: string[] | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare error: { code: string; message: string } | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare connectedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
