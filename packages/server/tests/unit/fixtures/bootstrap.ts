import { authenticatedTestClient, loginAs, testClient } from '../testClient';

/**
 * Drives the repeated bootstrap→admin→user→project→policy→noPerm sequence that
 * was copy-pasted across ~12 REST test files. Each call uses `prefix` to keep
 * usernames/project names unique per test file (test DB is shared per file
 * within a run, so collisions across files are avoided by prefixing).
 */
export const setupProjectWithUsers = async (args: {
  prefix: string;
  policyActions: string[];
  createOtherProject?: boolean;
  createNoPermUser?: boolean;
}): Promise<{
  adminToken: string;
  userToken: string;
  userId: string;
  projectId: string;
  otherProjectId?: string;
  policyId: string;
  noPermToken?: string;
}> => {
  const {
    prefix,
    policyActions,
    createOtherProject = false,
    createNoPermUser = true,
  } = args;

  await testClient
    .post('/api/v1/users/bootstrap')
    .send({ username: `${prefix}admin`, password: 'supersecret' });

  const adminToken = await loginAs(`${prefix}admin`, 'supersecret');

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

  const policyRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/policies')
    .send({
      document: {
        statement: [{ effect: 'Allow', action: policyActions }],
      },
    });
  const policyId = policyRes.body.id;

  await authenticatedTestClient(adminToken)
    .put(`/api/v1/users/${userId}/policies`)
    .send({ policy_ids: [policyId] });

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
};

/**
 * Provisions a principal whose policy is SRN-scoped to a single project
 * (`resource: ["soat:<project>:*:*"]`) rather than the wildcard `*` that
 * {@link setupProjectWithUsers} grants. This mirrors the effective boundary of a
 * project-scoped credential (project key / OAuth access token, see
 * `buildConsentPolicyFromScopeClaim`), and is the shape that exposes handlers
 * which authorize with no `resource` (defaulting to `*`, which an SRN-scoped
 * Allow cannot match). Returns a login token for the scoped user.
 */
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

  const policyRes = await authenticatedTestClient(args.adminToken)
    .post('/api/v1/policies')
    .send({
      document: {
        statement: [
          {
            effect: 'Allow',
            action: args.actions,
            resource: [`soat:${args.projectId}:*:*`],
          },
        ],
      },
    });

  await authenticatedTestClient(args.adminToken)
    .put(`/api/v1/users/${createUserRes.body.id}/policies`)
    .send({ policy_ids: [policyRes.body.id] });

  return loginAs(args.username, password);
};
