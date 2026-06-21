import { Column, DataType, Model, Table, Unique } from '@ttoss/postgresdb';

@Table({ tableName: 'oauth_consent_grants', timestamps: false })
export class OauthConsentGrant extends Model {
  @Unique
  @Column({ type: DataType.TEXT, allowNull: false })
  declare codeChallenge: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare subject: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare scopes: string; // space-separated scope string

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;
}
