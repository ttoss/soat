jest.mock('@soat/postgresdb');

jest.mock('@soat/documents-core', () => {
  return {
    createDocument: jest.fn(),
    getDocument: jest.fn(),
    updateDocument: jest.fn(),
    deleteDocument: jest.fn(),
    listDocuments: jest.fn(),
    searchDocumentsBySimilarity: jest.fn(),
  };
});
jest.mock('@soat/embeddings-core', () => {
  return {
    getConfigFromEnv: jest.fn(),
  };
});
jest.mock('@soat/files-core', () => {
  return {
    saveFile: jest.fn(),
    deleteFile: jest.fn(),
    retrieveFileById: jest.fn(),
    listFileRecords: jest.fn(),
    getFileRecord: jest.fn(),
  };
});
