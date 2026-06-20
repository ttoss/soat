import { Column, DataType, Model, Table, Unique } from '@ttoss/postgresdb';

@Table({ tableName: 'oauth_auth_codes', timestamps: false })
export class OauthAuthCode extends Model {
  @Unique
  @Column({ type: DataType.TEXT, allowNull: false })
  declare code: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare codeData: Record<string, unknown>;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;
}
