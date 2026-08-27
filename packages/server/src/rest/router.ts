import { Router } from '@ttoss/http-server';

import { responseContractMiddleware } from '../middleware/responseContract';
import { strictFieldsMiddleware } from '../middleware/strictFields';
import { v1Router } from './v1';

const restRouter = new Router();

// These two check the snake_case wire contract holds; neither modifies a body.
// `responseContract` is outermost so it observes the final response body.
restRouter.use(responseContractMiddleware);
// Rejects unknown request-body fields against the OpenAPI spec. Runs after the
// app-level authMiddleware (ctx.authUser resolved), before any route handler.
restRouter.use(strictFieldsMiddleware);
restRouter.use('/api/v1', v1Router.routes());

export { restRouter };
