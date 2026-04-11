import { Router } from '@ttoss/http-server';

import { actorsRouter } from './actors';
import { apiKeysRouter } from './apiKeys';
import { conversationsRouter } from './conversations';
import { documentsRouter } from './documents';
import { filesRouter } from './files';
import { projectsRouter } from './projects';
import { usersRouter } from './users';

const v1Router = new Router();

v1Router.use(actorsRouter.routes());
v1Router.use(apiKeysRouter.routes());
v1Router.use(conversationsRouter.routes());
v1Router.use(documentsRouter.routes());
v1Router.use(filesRouter.routes());
v1Router.use(projectsRouter.routes());
v1Router.use(usersRouter.routes());

export { v1Router };
