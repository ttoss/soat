import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
] as const;

export type OauthTokenEndpointAuthMethod =
  (typeof OAUTH_TOKEN_ENDPOINT_AUTH_METHODS)[number];

/**
 * A tenant's own OAuth 2.0 app at a third-party provider (public name
 * `oauth-clients`). `oauth_clients` is the server's own MCP authorization
 * table, hence the table name.
 */
@Table({
  tableName: 'oauth_provider_clients',
  indexes: [
    {
      name: 'oauth_provider_clients_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: OauthProviderClient) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.oauthClient);
      }
    },
  },
})
export class OauthProviderClient extends Model {
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

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare authorizeUrl: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare tokenUrl: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare revocationUrl: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientId: string;

  /** A `{{secret:...}}` reference, never the value. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare clientSecret: string | null;

  @Column({ type: DataType.JSON, allowNull: false })
  declare scopes: string[];

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare pkce: boolean;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    defaultValue: 'client_secret_basic',
  })
  declare tokenEndpointAuthMethod: OauthTokenEndpointAuthMethod;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare redirectUri: string | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare authorizeParams: Record<string, string> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
