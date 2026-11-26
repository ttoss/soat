import { db } from 'src/db';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The lexical channel's GIN index is partial and over an expression, so the
 * planner uses it only while the search's match is that expression and that
 * predicate verbatim. A match that drifts from the index still answers the
 * same rows, by re-tokenizing every chunk of every project, so only the plan
 * shows it: this captures the SQL a search runs and explains it with
 * sequential scans priced out, the state a large corpus puts the planner in.
 */
const TOKEN = 'QWRT-5512';

const isLexicalChunkQuery = (sql: string) => {
  return (
    sql.includes('websearch_to_tsquery') &&
    sql.includes('FROM "document_chunks"')
  );
};

describe('POST /api/v1/knowledge/search — lexical index', () => {
  let adminToken: string;
  let projectId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'lexidxadmin', password: 'supersecret' });
    adminToken = await loginAs('lexidxadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Lexical index' });
    expect(project.status).toBe(201);
    projectId = project.body.id;

    const document = await asAdmin()
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: `Part ${TOKEN} ships from the coastal warehouse.`,
        path: '/lexical/part.txt',
      });
    expect(document.status).toBe(201);
  });

  test('the lexical chunk query is one the GIN index answers', async () => {
    const executed: string[] = [];
    const { logging } = db.sequelize.options;
    db.sequelize.options.logging = (sql: string) => {
      executed.push(sql.replace(/^Executing \([^)]*\): /, ''));
    };
    try {
      const res = await asAdmin()
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: TOKEN });
      expect(res.status).toBe(200);
    } finally {
      db.sequelize.options.logging = logging;
    }

    const lexicalQuery = executed.find(isLexicalChunkQuery);
    expect(lexicalQuery).toBeDefined();

    const plan = await db.sequelize.transaction(async (transaction) => {
      await db.sequelize.query('SET LOCAL enable_seqscan = off', {
        transaction,
      });
      const [rows] = await db.sequelize.query(
        `EXPLAIN ${lexicalQuery!.replace(/;\s*$/, '')}`,
        { transaction }
      );
      return rows
        .map((row) => {
          return Object.values(row as Record<string, string>).join('');
        })
        .join('\n');
    });

    expect(plan).toContain('document_chunks_content_lexical_gin_idx');
  });
});
