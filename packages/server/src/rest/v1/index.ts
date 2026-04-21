import { Router } from '@ttoss/http-server';

import { actorsRouter } from './actors';
import { agentsRouter } from './agents';
import { aiProvidersRouter } from './aiProviders';
import { chatsRouter } from './chats';
import { conversationsRouter } from './conversations';
import { documentsRouter } from './documents';
import { filesRouter } from './files';
import { projectKeysRouter } from './projectKeys';
import { projectsRouter } from './projects';
import { secretsRouter } from './secrets';
import { usersRouter } from './users';
import { webhooksRouter } from './webhooks';

const v1Router = new Router();

v1Router.use(agentsRouter.routes());
v1Router.use(chatsRouter.routes());
v1Router.use(actorsRouter.routes());
v1Router.use(aiProvidersRouter.routes());
v1Router.use(projectKeysRouter.routes());
v1Router.use(conversationsRouter.routes());
v1Router.use(documentsRouter.routes());
v1Router.use(filesRouter.routes());
v1Router.use(projectsRouter.routes());
v1Router.use(secretsRouter.routes());
v1Router.use(usersRouter.routes());
v1Router.use(webhooksRouter.routes());

export { v1Router };
