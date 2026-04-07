import { Router } from '@ttoss/http-server';

import { filesRouter } from './files';

const v1Router = new Router();

v1Router.use(filesRouter.routes());

export { v1Router };
