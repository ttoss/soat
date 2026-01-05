import { App, bodyParser, cors } from '@ttoss/http-server';

import { mcpRouter } from './mcp';
import { restRouter } from './rest/router';

const app = new App();

app.use(cors());
app.use(bodyParser());

app.use('/mcp', mcpRouter.routes());
app.use('/api', restRouter.routes());
app.use('/api', restRouter.allowedMethods());

export default app;
