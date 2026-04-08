import { Router } from '@ttoss/http-server';

import { filesRouter } from './files';
import { projectsRouter } from './projects';
import { usersRouter } from './users';

const v1Router = new Router();

v1Router.use(filesRouter.routes());
v1Router.use(projectsRouter.routes());
v1Router.use(usersRouter.routes());

export { v1Router };
