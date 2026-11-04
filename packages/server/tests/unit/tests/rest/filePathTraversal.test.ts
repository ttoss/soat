import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('a file key that climbs above the root', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'file-traversal',
      policyActions: ['files:UploadFile', 'files:CreateFile'],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const uploadEscaping = (token?: string) => {
    const client = token ? authenticatedTestClient(token) : testClient;
    return client
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('escape'), { filename: 'x.txt' })
      .field('project_id', projectId)
      .field('filename', '../bob/x.txt');
  };

  test('POST /files/upload with a ../ filename field answers 400', async () => {
    const response = await uploadEscaping(userToken);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('the refusal comes after authentication', async () => {
    const response = await uploadEscaping();

    expect(response.status).toBe(401);
  });

  test('the refusal comes after authorization', async () => {
    const response = await uploadEscaping(noPermToken);

    expect(response.status).toBe(403);
  });

  test('POST /files/upload/base64 with a ../ prefix answers 400', async () => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: projectId,
        content: Buffer.from('escape').toString('base64'),
        prefix: '/../..',
        filename: 'x.txt',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('POST /files with a ../ filename answers 400', async () => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/files')
      .send({ project_id: projectId, filename: '../x.txt' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});
