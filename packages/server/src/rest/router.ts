import { Router } from '@ttoss/http-server';

import { v1Router } from './v1';

const restRouter = new Router();

restRouter.use('/api/v1', v1Router.routes());

export { restRouter };
