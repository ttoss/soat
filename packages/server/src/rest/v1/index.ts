import { Router } from '@ttoss/http-server';

import { documentsRouter } from './documents';
import { filesRouter } from './files';

const v1Router = new Router();

v1Router.use('/documents', documentsRouter.routes());
v1Router.use('/files', filesRouter.routes());

export { v1Router };
