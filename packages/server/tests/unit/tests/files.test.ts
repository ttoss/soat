import { testClient } from '../testClient';

describe('GET /api/v1/files', () => {
  test('should return empty list initially', async () => {
    const response = await testClient.get('/api/v1/files');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe('POST /api/v1/files', () => {
  test('should create a file', async () => {
    const payload = {
      filename: 'test.txt',
      contentType: 'text/plain',
      size: 1024,
      storageType: 'local',
      storagePath: '/tmp/test.txt',
    };

    const response = await testClient.post('/api/v1/files').send(payload);

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.filename).toBe(payload.filename);
    expect(response.body.contentType).toBe(payload.contentType);
    expect(response.body.size).toBe(payload.size);
    expect(response.body.storageType).toBe(payload.storageType);
    expect(response.body.storagePath).toBe(payload.storagePath);
  });
});

describe('GET /api/v1/files/:id', () => {
  test('should return a created file by id', async () => {
    const payload = {
      filename: 'image.png',
      contentType: 'image/png',
      size: 2048,
      storageType: 's3',
      storagePath: 's3://bucket/image.png',
    };

    const createResponse = await testClient.post('/api/v1/files').send(payload);
    const { id } = createResponse.body;

    const response = await testClient.get(`/api/v1/files/${id}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(id);
    expect(response.body.filename).toBe(payload.filename);
  });

  test('should return 404 for unknown id', async () => {
    const response = await testClient.get(
      '/api/v1/files/00000000-0000-0000-0000-000000000000'
    );

    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/v1/files/:id', () => {
  test('should delete a file', async () => {
    const payload = {
      filename: 'delete-me.txt',
      contentType: 'text/plain',
      size: 512,
      storageType: 'local',
      storagePath: '/tmp/delete-me.txt',
    };

    const createResponse = await testClient.post('/api/v1/files').send(payload);
    const { id } = createResponse.body;

    const deleteResponse = await testClient.delete(`/api/v1/files/${id}`);
    expect(deleteResponse.status).toBe(204);

    const getResponse = await testClient.get(`/api/v1/files/${id}`);
    expect(getResponse.status).toBe(404);
  });
});
