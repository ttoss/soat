import { Column, DataType, Model, Table, Unique } from '@ttoss/postgresdb';

@Table({ tableName: 'oauth_clients', timestamps: false })
export class OauthClient extends Model {
  @Unique
  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientId: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare clientData: object;
}
