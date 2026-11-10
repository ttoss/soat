import { authenticatedTestClient } from '../testClient';

const ids = (body: { data: { id: string }[] }): string[] => {
  return body.data.map((row) => {
    return row.id;
  });
};

/**
 * An unrestricted admin listing without `project_id` reads every project: the
 * rows `projectId` lists are all in the unscoped list.
 */
export const expectAdminListSpansProjects = async (args: {
  adminToken: string;
  path: string;
  projectId: string;
  query?: Record<string, string>;
}): Promise<void> => {
  const client = authenticatedTestClient(args.adminToken);
  const scoped = await client
    .get(args.path)
    .query({ ...args.query, project_id: args.projectId, limit: 100 });
  expect(scoped.status).toBe(200);
  expect(scoped.body.data.length).toBeGreaterThan(0);

  const unscoped = await authenticatedTestClient(args.adminToken)
    .get(args.path)
    .query({ ...args.query, limit: 100 });
  expect(unscoped.status).toBe(200);
  expect(ids(unscoped.body)).toEqual(expect.arrayContaining(ids(scoped.body)));
};
