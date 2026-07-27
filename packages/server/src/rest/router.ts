import { Router } from '@ttoss/http-server';

import { responseContractMiddleware } from '../middleware/responseContract';
import { strictFieldsMiddleware } from '../middleware/strictFields';
import { v1Router } from './v1';

const restRouter = new Router();

// The wire contract is snake_case in both directions and nothing rewrites keys
// in between: handlers read the body as sent, and lib mappers serialize each
// response field by field. These two middlewares check the contract holds —
// they never modify a body.
//
// `responseContract` is outermost so it observes the final response body.
restRouter.use(responseContractMiddleware);
// Rejects unknown request-body fields against the OpenAPI spec. Runs after the
// app-level authMiddleware (ctx.authUser resolved), before any route handler.
restRouter.use(strictFieldsMiddleware);
restRouter.use('/api/v1', v1Router.routes());

export { restRouter };
