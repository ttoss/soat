import { sweepExpiredFiles } from 'src/lib/fileDeletion';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { captureEvents } from '../../fixtures/eventCapture';
import { authenticatedTestClient } from '../../testClient';

/**
 * The expired-file sweep, driven as the scheduler tick (unit tests never
 * import `server.ts`). Reads already answer `404` past `expires_at`; the sweep
 * is what deletes the bytes and the row, announced as `files.deleted`.
 */
describe('expired file sweep', () => {
  let adminToken: string;
  let projectId: string;

  const upload = async (body: Record<string, unknown>): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: projectId,
        content: Buffer.from('swept').toString('base64'),
        content_type: 'text/plain',
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const deletedIds = async (action: () => Promise<unknown>) => {
    const events = await captureEvents({
      type: 'files.deleted',
      where: () => {
        return true;
      },
      action,
      count: 1000,
    });
    return events.map((event) => {
      return event.resourceId;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fileexpiry',
      policyActions: [],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  test('deletes a file once its expires_at has passed', async () => {
    const fileId = await upload({ filename: 'due.txt', expires_in: 60 });

    const deleted = await deletedIds(() => {
      return sweepExpiredFiles({ now: new Date(Date.now() + 120 * 1000) });
    });

    expect(deleted).toContain(fileId);
  });

  test('leaves a file whose expires_at is still ahead', async () => {
    const fileId = await upload({ filename: 'ahead.txt', expires_in: 3600 });

    const deleted = await deletedIds(() => {
      return sweepExpiredFiles({ now: new Date(Date.now() + 60 * 1000) });
    });

    expect(deleted).not.toContain(fileId);
    const read = await authenticatedTestClient(adminToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(read.status).toBe(200);
  });

  test('leaves a file without a lifetime', async () => {
    const fileId = await upload({ filename: 'forever.txt' });

    const deleted = await deletedIds(() => {
      return sweepExpiredFiles({
        now: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      });
    });

    expect(deleted).not.toContain(fileId);
  });

  test('a single-use file no generation read is deleted at its ceiling', async () => {
    const fileId = await upload({
      filename: 'never-read.txt',
      delete_after: 'generation',
    });

    const deleted = await deletedIds(() => {
      return sweepExpiredFiles({
        now: new Date(Date.now() + 25 * 3600 * 1000),
      });
    });

    expect(deleted).toContain(fileId);
  });
});
