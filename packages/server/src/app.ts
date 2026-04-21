import { addHealthCheck, App, bodyParser, cors } from '@ttoss/http-server';

import { mcpRouter } from './mcp/server';
import { initializeDispatcher } from './lib/webhookDispatcher';
import { authMiddleware } from './middleware/auth';
import { restRouter } from './rest/router';

const app = new App();

addHealthCheck({ app });

initializeDispatcher();

app.use(cors());
app.use(bodyParser());
app.use(authMiddleware);

app.use(restRouter.routes());
app.use(restRouter.allowedMethods());

app.use(mcpRouter.routes());
app.use(mcpRouter.allowedMethods());

export { app };
