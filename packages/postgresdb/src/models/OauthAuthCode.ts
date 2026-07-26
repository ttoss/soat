import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

@Table({
  tableName: 'oauth_auth_codes',
  indexes: [
    {
      name: 'oauth_auth_codes_code_unique',
      unique: true,
      fields: ['code'],
    },
  ],
  timestamps: false,
})
export class OauthAuthCode extends Model {
  @Column({ type: DataType.TEXT, allowNull: false })
  declare code: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare codeData: object;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;
}
