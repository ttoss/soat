import { Router } from '@ttoss/http-server';

import { actorsRouter } from './actors';
import { actorTagsRouter } from './actorTags';
import { agentsRouter } from './agents';
import { aiProvidersRouter } from './aiProviders';
import { apiKeysRouter } from './apiKeys';
import { chatsRouter } from './chats';
import { conversationsRouter } from './conversations';
import { documentsRouter } from './documents';
import { filesRouter } from './files';
import { formationsRouter } from './formations';
import { knowledgeRouter } from './knowledge';
import { memoriesRouter } from './memories';
import { orchestrationsRouter } from './orchestrations';
import { policiesRouter } from './policies';
import { projectsRouter } from './projects';
import { secretsRouter } from './secrets';
import { toolsRouter } from './tools';
import { tracesRouter } from './traces';
import { usersRouter } from './users';
import { webhooksRouter } from './webhooks';

const v1Router = new Router();

v1Router.use(formationsRouter.routes());
v1Router.use(agentsRouter.routes());
v1Router.use(chatsRouter.routes());
v1Router.use(actorsRouter.routes());
v1Router.use(actorTagsRouter.routes());
v1Router.use(aiProvidersRouter.routes());
v1Router.use(apiKeysRouter.routes());
v1Router.use(memoriesRouter.routes());
v1Router.use(policiesRouter.routes());
v1Router.use(conversationsRouter.routes());
v1Router.use(documentsRouter.routes());
v1Router.use(filesRouter.routes());
v1Router.use(knowledgeRouter.routes());
v1Router.use(projectsRouter.routes());
v1Router.use(secretsRouter.routes());
v1Router.use(orchestrationsRouter.routes());
v1Router.use(toolsRouter.routes());
v1Router.use(tracesRouter.routes());
v1Router.use(usersRouter.routes());
v1Router.use(webhooksRouter.routes());

export { v1Router };
