import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

@Table({
  tableName: 'oauth_clients',
  indexes: [
    {
      name: 'oauth_clients_client_id_unique',
      unique: true,
      fields: ['client_id'],
    },
  ],
  timestamps: false,
})
export class OauthClient extends Model {
  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientId: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare clientData: object;
}
