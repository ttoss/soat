import { App, bodyParser, cors } from '@ttoss/http-server';

import { mcpRouter } from './mcp/server';
import { restRouter } from './rest/router';

const app = new App();

app.use(cors());
app.use(bodyParser());

app.use(restRouter.routes());
app.use(restRouter.allowedMethods());

app.use(mcpRouter.routes());
app.use(mcpRouter.allowedMethods());

export { app };
