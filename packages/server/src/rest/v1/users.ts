import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createFirstAdminUser,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  loginUser,
} from 'src/lib/users';

const usersRouter = new Router<Context>();

/**
 * @openapi
 * /users:
 *   get:
 *     tags:
 *       - Users
 *     summary: List all users
 *     description: Returns a list of all users
 *     operationId: listUsers
 *     responses:
 *       '200':
 *         description: List of users returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/UserRecord'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
usersRouter.get('/users', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listUsers();
});

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get a user by ID
 *     description: Returns the data of a specific user
 *     operationId: getUser
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: User ID
 *         schema:
 *           type: string
 *           example: 'usr_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: User found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserRecord'
 *       '404':
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
usersRouter.get('/users/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const user = await getUser({ id: ctx.params.id });

  if (!user) {
    ctx.status = 404;
    ctx.body = { error: 'User not found' };
    return;
  }

  ctx.body = user;
});

/**
 * @openapi
 * /users:
 *   post:
 *     tags:
 *       - Users
 *     summary: Create a user
 *     description: Creates a new user in the system
 *     operationId: createUser
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 example: 'johndoe'
 *               password:
 *                 type: string
 *                 format: password
 *                 example: 'supersecret'
 *               role:
 *                 type: string
 *                 enum: [admin, user]
 *                 example: 'user'
 *     responses:
 *       '201':
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserRecord'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
usersRouter.post('/users', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    username: string;
    password: string;
    role?: 'admin' | 'user';
  };

  const user = await createUser(body);
  ctx.status = 201;
  ctx.body = user;
});

/**
 * @openapi
 * /users/bootstrap:
 *   post:
 *     tags:
 *       - Users
 *     summary: Create the first admin user
 *     description: Creates the first admin user. Returns 409 if any user already exists.
 *     operationId: bootstrapUser
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 example: 'admin'
 *               password:
 *                 type: string
 *                 format: password
 *                 example: 'supersecret'
 *     responses:
 *       '201':
 *         description: Admin user created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserRecord'
 *       '409':
 *         description: Users already exist
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
usersRouter.post('/users/bootstrap', async (ctx: Context) => {
  const body = ctx.request.body as {
    username: string;
    password: string;
  };

  const user = await createFirstAdminUser(body);

  if (!user) {
    ctx.status = 409;
    ctx.body = { error: 'Users already exist' };
    return;
  }

  ctx.status = 201;
  ctx.body = user;
});

/**
 * @openapi
 * /users/login:
 *   post:
 *     tags:
 *       - Users
 *     summary: Login
 *     description: Authenticates a user and returns a JWT token
 *     operationId: loginUser
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 example: 'admin'
 *               password:
 *                 type: string
 *                 format: password
 *                 example: 'supersecret'
 *     responses:
 *       '200':
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/UserRecord'
 *                 - type: object
 *                   required:
 *                     - token
 *                   properties:
 *                     token:
 *                       type: string
 *       '401':
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
usersRouter.post('/users/login', async (ctx: Context) => {
  const { username, password } = ctx.request.body as {
    username: string;
    password: string;
  };

  const result = await loginUser({ username, password });

  if (!result) {
    ctx.status = 401;
    ctx.body = { error: 'Invalid credentials' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /users/{id}:
 *   delete:
 *     tags:
 *       - Users
 *     summary: Delete a user
 *     description: Deletes a user by ID. Admin only.
 *     operationId: deleteUser
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: User ID
 *         schema:
 *           type: string
 *           example: 'usr_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: User deleted successfully
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
usersRouter.delete('/users/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const deleted = await deleteUser({ id: ctx.params.id });

  if (!deleted) {
    ctx.status = 404;
    ctx.body = { error: 'User not found' };
    return;
  }

  ctx.status = 204;
});

export { usersRouter };
