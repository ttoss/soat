import { Router } from '@ttoss/http-server';

import { caseTransformMiddleware } from '../middleware/caseTransform';
import { strictFieldsMiddleware } from '../middleware/strictFields';
import { v1Router } from './v1';

const restRouter = new Router();

restRouter.use(caseTransformMiddleware);
// Rejects unknown request-body fields against the OpenAPI spec. Runs after
// caseTransform (body is camelCase) and the app-level authMiddleware
// (ctx.authUser resolved), before any route handler.
restRouter.use(strictFieldsMiddleware);
restRouter.use('/api/v1', v1Router.routes());

export { restRouter };
