import { Router } from '@ttoss/http-server';

import { v1Router } from './v1';

const restRouter: Router = new Router();

restRouter.use('/v1', v1Router.routes());

export { restRouter };
