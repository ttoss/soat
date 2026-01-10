import {
  deleteFile,
  type FileData,
  type FileRecord,
  getFileRecord,
  listFileRecords,
  retrieveFileById,
  saveFile,
} from '@soat/files-core';
import { app } from 'src/app';
import request from 'supertest';

describe('Files API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/files/', () => {
    test('should list files successfully', async () => {
      const mockFiles = [
        {
          id: 'file-1',
          filename: 'test1.txt',
          contentType: 'text/plain',
          size: 100,
          storageType: 'local',
          storagePath: '/tmp/files/test1.txt',
          metadata: {},
          createdAt: '2026-01-09T16:27:01.999Z',
          updatedAt: '2026-01-09T16:27:01.999Z',
        },
      ];

      jest
        .mocked(listFileRecords)
        .mockResolvedValue(mockFiles as unknown as FileRecord[]);

      const response = await request(app.callback())
        .get('/api/v1/files/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        files: mockFiles,
      });
      expect(listFileRecords).toHaveBeenCalled();
    });

    test('should handle error when listing files', async () => {
      jest
        .mocked(listFileRecords)
        .mockRejectedValue(new Error('Database error'));

      const response = await request(app.callback())
        .get('/api/v1/files/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Database error',
      });
    });
  });

  describe('POST /api/v1/files/upload', () => {
    test('should create a file via REST API', async () => {
      const savedFile = {
        id: 'test-id',
        filename: 'test.txt',
        content: 'Hello, World!',
        metadata: {},
      };

      jest.mocked(saveFile).mockResolvedValue(savedFile);

      const response = await request(app.callback())
        .post('/api/v1/files/upload')
        .send({
          content: 'Hello, World!',
          options: { metadata: { filename: 'test.txt' } },
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: 'test-id',
        filename: 'test.txt',
        success: true,
      });
      expect(saveFile).toHaveBeenCalledWith({
        config: { local: { path: '/tmp/files' }, type: 'local' },
        content: 'Hello, World!',
        options: { metadata: { filename: 'test.txt' } },
      });
    });

    test('should return 400 if content is missing', async () => {
      const response = await request(app.callback())
        .post('/api/v1/files/upload')
        .send({
          options: { metadata: { filename: 'test.txt' } },
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'Content is required',
      });
    });

    test('should handle error when uploading file', async () => {
      jest.mocked(saveFile).mockRejectedValue(new Error('Upload error'));

      const response = await request(app.callback())
        .post('/api/v1/files/upload')
        .send({
          content: 'Hello, World!',
          options: { metadata: { filename: 'test.txt' } },
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Upload error',
      });
    });
  });

  describe('GET /api/v1/files/:id', () => {
    test('should get file by id successfully', async () => {
      const mockFile = {
        id: 'file-1',
        content: 'Hello, World!',
      };
      const mockRecord = {
        id: 'file-1',
        filename: 'test.txt',
        contentType: 'text/plain',
        size: 13,
        storageType: 'local',
        storagePath: '/tmp/files/test.txt',
        metadata: { filename: 'test.txt' },
        createdAt: '2026-01-09T16:27:02.079Z',
        updatedAt: '2026-01-09T16:27:02.079Z',
      };

      jest.mocked(retrieveFileById).mockResolvedValue(mockFile as FileData);
      jest
        .mocked(getFileRecord)
        .mockResolvedValue(mockRecord as unknown as FileRecord);

      const response = await request(app.callback())
        .get('/api/v1/files/file-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        file: mockFile,
        record: mockRecord,
      });
      expect(retrieveFileById).toHaveBeenCalledWith({
        config: { local: { path: '/tmp/files' }, type: 'local' },
        id: 'file-1',
      });
      expect(getFileRecord).toHaveBeenCalledWith('file-1');
    });

    test('should return 404 if file not found', async () => {
      jest.mocked(retrieveFileById).mockResolvedValue(null);

      const response = await request(app.callback())
        .get('/api/v1/files/file-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: 'File not found',
      });
    });

    test('should handle error when getting file', async () => {
      jest.mocked(retrieveFileById).mockRejectedValue(new Error('Get error'));

      const response = await request(app.callback())
        .get('/api/v1/files/file-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Get error',
      });
    });
  });

  describe('DELETE /api/v1/files/:id', () => {
    test('should delete file successfully', async () => {
      jest.mocked(deleteFile).mockResolvedValue(true);

      const response = await request(app.callback())
        .delete('/api/v1/files/file-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
      });
      expect(deleteFile).toHaveBeenCalledWith({
        config: { local: { path: '/tmp/files' }, type: 'local' },
        id: 'file-1',
      });
    });

    test('should return 404 if file not found', async () => {
      jest.mocked(deleteFile).mockResolvedValue(false);

      const response = await request(app.callback())
        .delete('/api/v1/files/file-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: 'File not found',
      });
    });

    test('should handle error when deleting file', async () => {
      jest.mocked(deleteFile).mockRejectedValue(new Error('Delete error'));

      const response = await request(app.callback())
        .delete('/api/v1/files/file-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Delete error',
      });
    });
  });
});
