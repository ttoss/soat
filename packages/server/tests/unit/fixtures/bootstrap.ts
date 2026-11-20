import { authenticatedTestClient, loginAs, testClient } from '../testClient';

type SetupProjectWithUsersArgs = {
  prefix: string;
  policyActions: string[];
  createOtherProject?: boolean;
  createNoPermUser?: boolean;
};

type SetupProjectWithUsersResult = {
  adminToken: string;
  userToken: string;
  userId: string;
  projectId: string;
  otherProjectId?: string;
  noPermToken?: string;
};

const grantPolicy = async (args: {
  adminToken: string;
  userId: string;
  actions: string[];
}): Promise<string> => {
  const policyRes = await authenticatedTestClient(args.adminToken)
    .post('/api/v1/policies')
    .send({
      document: { statement: [{ effect: 'Allow', action: args.actions }] },
    });
  if (policyRes.status !== 201) {
    throw new Error(
      `setupProjectWithUsers: policy ${policyRes.status} ${JSON.stringify(policyRes.body)}`
    );
  }
  const attachRes = await authenticatedTestClient(args.adminToken)
    .put(`/api/v1/users/${args.userId}/policies`)
    .send({ policy_ids: [policyRes.body.id] });
  if (attachRes.status < 200 || attachRes.status >= 300) {
    throw new Error(`setupProjectWithUsers: attach ${attachRes.status}`);
  }
  return policyRes.body.id as string;
};

/**
 * Bootstrap creates one admin per database, and each test file has its own
 * database and module registry: the first setup's admin serves every later one.
 */
let fileAdmin: { username: string; password: string } | undefined;

const adminTokenFor = async (args: { prefix: string }): Promise<string> => {
  const admin = fileAdmin ?? {
    username: `${args.prefix}admin`,
    password: 'supersecret',
  };
  if (!fileAdmin) {
    const res = await testClient.post('/api/v1/users/bootstrap').send(admin);
    if (res.status === 201) fileAdmin = admin;
  }
  const token = await loginAs(admin.username, admin.password);
  if (!token) {
    throw new Error(`setupProjectWithUsers: ${admin.username} cannot log in`);
  }
  return token;
};

/**
 * Drives the bootstrap→admin→user→project→policy→noPerm sequence. `prefix`
 * keeps usernames and project names unique per test file.
 *
 * `policyActions: []` grants the user nothing: no policy is created, since the
 * server refuses an empty `action` list.
 */
export function setupProjectWithUsers(
  args: SetupProjectWithUsersArgs & { policyActions: [] }
): Promise<SetupProjectWithUsersResult & { policyId?: undefined }>;
export function setupProjectWithUsers(
  args: SetupProjectWithUsersArgs
): Promise<SetupProjectWithUsersResult & { policyId: string }>;
export async function setupProjectWithUsers(
  args: SetupProjectWithUsersArgs
): Promise<SetupProjectWithUsersResult & { policyId?: string }> {
  const {
    prefix,
    policyActions,
    createOtherProject = false,
    createNoPermUser = true,
  } = args;

  const adminToken = await adminTokenFor({ prefix });

  const createUserRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/users')
    .send({ username: `${prefix}user`, password: `${prefix}pass` });

  const userId = createUserRes.body.id;
  const userToken = await loginAs(`${prefix}user`, `${prefix}pass`);

  const projectRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/projects')
    .send({ name: `${prefix} Test Project` });
  const projectId = projectRes.body.id;

  let otherProjectId: string | undefined;

  if (createOtherProject) {
    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: `${prefix} Other Project` });
    otherProjectId = otherProjectRes.body.id;
  }

  const policyId =
    policyActions.length === 0
      ? undefined
      : await grantPolicy({ adminToken, userId, actions: policyActions });

  let noPermToken: string | undefined;

  if (createNoPermUser) {
    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: `${prefix}noperm`, password: 'nopassword' });
    noPermToken = await loginAs(`${prefix}noperm`, 'nopassword');
  }

  return {
    adminToken,
    userToken,
    userId,
    projectId,
    otherProjectId,
    policyId,
    noPermToken,
  };
}

/**
 * Provisions a principal whose policy is SRN-scoped to a single project
 * (`resource: ["srn:<project>:*:*"]`) rather than the wildcard `*` that
 * {@link setupProjectWithUsers} grants. This mirrors the effective boundary of a
 * project-scoped credential (project key / OAuth access token, see
 * `buildConsentPolicyFromScopeClaim`), and is the shape that exposes handlers
 * which authorize with no `resource` (defaulting to `*`, which an SRN-scoped
 * Allow cannot match). Returns a login token for the scoped user.
 */
/** A policy allowing `actions` on every resource of the project. */
export const createProjectPolicy = async (args: {
  adminToken: string;
  projectId: string;
  actions: string[];
}): Promise<string> => {
  const res = await authenticatedTestClient(args.adminToken)
    .post('/api/v1/policies')
    .send({
      document: {
        statement: [
          {
            effect: 'Allow',
            action: args.actions,
            resource: [`srn:${args.projectId}:*:*`],
          },
        ],
      },
    });
  if (res.status !== 201) {
    throw new Error(`createProjectPolicy: ${res.status}`);
  }
  return res.body.id as string;
};

export const createScopedPrincipal = async (args: {
  adminToken: string;
  projectId: string;
  username: string;
  actions: string[];
}): Promise<string> => {
  const password = `${args.username}pass`;
  const createUserRes = await authenticatedTestClient(args.adminToken)
    .post('/api/v1/users')
    .send({ username: args.username, password });

  const policyId = await createProjectPolicy(args);

  await authenticatedTestClient(args.adminToken)
    .put(`/api/v1/users/${createUserRes.body.id}/policies`)
    .send({ policy_ids: [policyId] });

  return loginAs(args.username, password);
};

/**
 * A policy allowing every action: the `policy_ids` of an admin-created trigger
 * in a test that is not about what its firings may do.
 */
export const createAllowAllPolicy = async (args: {
  adminToken: string;
}): Promise<string> => {
  const res = await authenticatedTestClient(args.adminToken)
    .post('/api/v1/policies')
    .send({ document: { statement: [{ effect: 'Allow', action: ['*'] }] } });
  if (res.status !== 201) {
    throw new Error(`createAllowAllPolicy: ${res.status}`);
  }
  return res.body.id as string;
};

const allowAllGrants = new Map<string, Promise<string[]>>();

/**
 * `policy_ids` allowing every action, written by admin `token`: the grant of
 * an eval, decider, ingestion rule, memory rule or playbook in a test that is
 * not about what its work may do. One policy per token per test file.
 */
export const testGrant = (args: { token: string }): Promise<string[]> => {
  const cached = allowAllGrants.get(args.token);
  if (cached) return cached;
  const grant = createAllowAllPolicy({ adminToken: args.token }).then((id) => {
    return [id];
  });
  allowAllGrants.set(args.token, grant);
  return grant;
};
