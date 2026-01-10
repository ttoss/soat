import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sequelize } from '@ttoss/postgresdb';
import { initialize } from '@ttoss/postgresdb';
import { models } from 'dist/index';

let sequelize: Sequelize;
let postgresContainer: StartedPostgreSqlContainer;

jest.setTimeout(60000);

beforeAll(async () => {
  // Start PostgreSQL container
  postgresContainer = await new PostgreSqlContainer(
    'pgvector/pgvector:0.8.1-pg18-trixie'
  ).start();

  // Initialize database with container credentials
  const db = await initialize({
    createVectorExtension: true,
    models,
    logging: false,
    username: postgresContainer.getUsername(),
    password: postgresContainer.getPassword(),
    database: postgresContainer.getDatabase(),
    host: postgresContainer.getHost(),
    port: postgresContainer.getPort(),
  });

  sequelize = db.sequelize;

  // Sync database schema
  await sequelize.sync();
});

afterAll(async () => {
  await sequelize.close();
  await postgresContainer.stop();
});

describe('File model', () => {
  test('should create and retrieve file', async () => {
    const metadata = { uploadedBy: 'test-user' };
    const fileData = {
      filename: 'test.txt',
      contentType: 'text/plain',
      size: 1024,
      storageType: 'local' as const,
      storagePath: '/tmp/test-file-id',
      metadata: JSON.stringify(metadata),
    };

    const file = await models.File.create(fileData);

    expect(file.filename).toBe(fileData.filename);
    expect(file.contentType).toBe(fileData.contentType);
    expect(file.size).toBe(fileData.size);
    expect(file.storageType).toBe(fileData.storageType);
    expect(file.storagePath).toBe(fileData.storagePath);
    expect(JSON.parse(file.metadata!)).toEqual(metadata);

    const foundFile = await models.File.findByPk(file.id);

    expect(foundFile).toMatchObject({
      id: file.id,
      filename: fileData.filename,
      contentType: fileData.contentType,
      size: fileData.size,
      storageType: fileData.storageType,
      storagePath: fileData.storagePath,
    });
    expect(JSON.parse(foundFile!.metadata!)).toEqual(metadata);
  });

  test('should update file metadata', async () => {
    const fileData = {
      filename: 'update-test.txt',
      contentType: 'text/plain',
      size: 512,
      storageType: 's3' as const,
      storagePath: 's3://bucket/update-test-file-id',
    };

    const file = await models.File.create(fileData);

    // Update metadata
    const newMetadata = { updatedBy: 'admin', version: 2 };
    await file.update({
      metadata: JSON.stringify(newMetadata),
      size: 1024,
    });

    const updatedFile = await models.File.findByPk(file.id);

    expect(updatedFile!.size).toBe(1024);
    expect(JSON.parse(updatedFile!.metadata!)).toEqual(newMetadata);
  });

  test('should delete file', async () => {
    const fileData = {
      filename: 'delete-test.txt',
      contentType: 'application/json',
      size: 256,
      storageType: 'gcs' as const,
      storagePath: 'gs://bucket/delete-test-file-id',
    };

    const file = await models.File.create(fileData);

    const createdFile = await models.File.findByPk(file.id);
    expect(createdFile).toBeTruthy();

    await createdFile!.destroy();

    const deletedFile = await models.File.findByPk(file.id);
    expect(deletedFile).toBeNull();
  });

  test('should handle files without metadata', async () => {
    const fileData = {
      contentType: 'image/png',
      size: 2048,
      storageType: 'local' as const,
      storagePath: '/tmp/no-metadata-file-id',
    };

    const file = await models.File.create(fileData);

    expect(file.metadata).toBeNull();

    const foundFile = await models.File.findByPk(file.id);
    expect(foundFile!.metadata).toBeNull();
  });
});
