import type { db } from '../db';

export type SequelizeInstance = typeof db.sequelize;
// The transaction type as `sequelize.query` expects it — derived from the query
// options so it stays correct without importing sequelize's internals directly
// (`@ttoss/postgresdb` does not re-export `Transaction`).
export type Transaction = NonNullable<
  NonNullable<Parameters<SequelizeInstance['query']>[1]>['transaction']
>;
