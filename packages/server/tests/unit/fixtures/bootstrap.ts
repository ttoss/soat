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
