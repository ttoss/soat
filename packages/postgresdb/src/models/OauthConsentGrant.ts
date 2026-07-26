import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

@Table({
  tableName: 'oauth_consent_grants',
  indexes: [
    {
      name: 'oauth_consent_grants_code_challenge_unique',
      unique: true,
      fields: ['code_challenge'],
    },
  ],
  timestamps: false,
})
export class OauthConsentGrant extends Model {
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
