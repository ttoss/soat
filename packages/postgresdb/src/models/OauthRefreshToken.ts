import { Column, DataType, Model, Table, Unique } from '@ttoss/postgresdb';

@Table({ tableName: 'oauth_refresh_tokens', timestamps: false })
export class OauthRefreshToken extends Model {
  @Unique
  @Column({ type: DataType.TEXT, allowNull: false })
  declare tokenHash: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare subject: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare scopes: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare consumedAt: Date | null;
}
