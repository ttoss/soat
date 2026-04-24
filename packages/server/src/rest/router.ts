import { Router } from '@ttoss/http-server';

import { caseTransformMiddleware } from '../middleware/caseTransform';
import { v1Router } from './v1';

const restRouter = new Router();

restRouter.use(caseTransformMiddleware);
restRouter.use('/api/v1', v1Router.routes());

export { restRouter };
