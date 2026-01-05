import { models } from '@soat/postgresdb';
import { initialize } from '@ttoss/postgresdb';

export const initializeDatabase = async () => {
  return initialize({ models });
};

export { models };
