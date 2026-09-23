import fs from 'node:fs';

import { db } from 'src/db';
import * as embeddingModule from 'src/lib/embedding';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Two updates that read the same version: the one that loses the claim is
 * `409` and leaves nothing behind — not its stored text, not its chunks. The
 * embedding call is where a document update waits on the outside world, so the
 * first writer is held there while the second completes.
 */
describe('Concurrent document updates', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docrace',
      policyActions: ['documents:*'],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const chunkContents = async (id: string) => {
    const doc = await db.Document.findOne({ where: { publicId: id } });
    const chunks = await db.DocumentChunk.findAll({
      where: { documentId: doc!.id as number },
    });
    return chunks.map((chunk) => {
      return chunk.content;
    });
  };

  // `GET` rebuilds `content` from the chunks; the stored text is what the next
  // version snapshot, a restore and a formation read.
  const storedText = async (id: string) => {
    const doc = await db.Document.findOne({ where: { publicId: id } });
    const file = await db.File.findByPk(doc!.fileId);
    return fs.readFileSync(file!.storagePath, 'utf-8');
  };

  test.each([
    ['both state expected_version', { expected_version: 1 }],
    ['neither states a precondition', {}],
  ])(
    'the loser leaves no content behind when %s',
    async (_label, precondition) => {
      const created = await client()
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Original.',
          path: `/race/${crypto.randomUUID()}.txt`,
        });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const original = embeddingModule.getEmbedding;
      let releaseFirst: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      jest
        .spyOn(embeddingModule, 'getEmbedding')
        .mockImplementationOnce(async (args) => {
          firstEntered();
          await held;
          return original(args);
        });

      const first = client()
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Writer A.', ...precondition })
        .then((res) => {
          return res;
        });
      await entered;

      const second = await client()
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Writer B.', ...precondition });
      expect(second.status).toBe(200);
      expect(second.body.version).toBe(2);

      releaseFirst();
      const loser = await first;
      expect(loser.status).toBe(409);
      expect(loser.body.error.code).toBe('VERSION_CONFLICT');

      const read = await client().get(`/api/v1/documents/${id}`);
      expect(read.body.content).toBe('Writer B.');
      expect(read.body.version).toBe(2);
      expect(await chunkContents(id)).toEqual(['Writer B.']);
      expect(await storedText(id)).toBe('Writer B.');
    }
  );
});
