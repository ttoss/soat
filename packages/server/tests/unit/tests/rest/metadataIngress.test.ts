import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A `metadata` bag is caller-owned and stored as written, which is what makes
 * its type worth refusing at the door: the column is JSONB, so it stores
 * `"a string"` as happily as an object, and the structured filter added in
 * #1398 then reads that row as matching nothing — a bad write becomes an
 * invisible read.
 *
 * So every entry point that stores a bag answers the same way, through
 * `lib/metadataBag.ts`. Two surfaces that mention `metadata` are deliberately
 * not ingresses and are asserted as such below: knowledge search takes a
 * filter over bags, and the metadata-schema validator judges a bag instead of
 * keeping one.
 */
describe('every metadata ingress refuses a non-object bag', () => {
  let userToken: string;
  let projectId: string;
  let conversationId: string;
  let documentId: string;
  let toolId: string;
  let ingestionRuleId: string;
  let formationId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'metaingress',
      policyActions: [
        'conversations:CreateConversation',
        'conversations:UpdateConversation',
        'documents:CreateDocument',
        'documents:UpdateDocument',
        'formations:CreateFormation',
        'formations:UpdateFormation',
        'ingestion-rules:CreateIngestionRule',
        'ingestion-rules:UpdateIngestionRule',
        'tools:CreateTool',
        'metadata-schemas:ListMetadataSchemas',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const conversation = await client()
      .post('/api/v1/conversations')
      .send({ project_id: projectId, name: 'ingress' });
    conversationId = conversation.body.id;

    const document = await client().post('/api/v1/documents').send({
      project_id: projectId,
      content: 'Ingress fixture',
      filename: 'ingress.txt',
    });
    documentId = document.body.id;

    const tool = await client()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'ingress-tool',
        type: 'builtin',
        description: 'ingress fixture',
        actions: ['list-tools'],
      });
    toolId = tool.body.id;

    const rule = await client().post('/api/v1/ingestion-rules').send({
      project_id: projectId,
      content_type_glob: 'text/*',
      tool_id: toolId,
      action: 'list-tools',
    });
    ingestionRuleId = rule.body.id;

    const formation = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'ingress-formation',
        template: { resources: {} },
      });
    formationId = formation.body.id;
  });

  /** The bag, sent as something that is not an object. */
  const NOT_A_BAG = 'a string';

  describe('a bag that is stored', () => {
    /**
     * Sends the same request twice — once with a bag that is not an object,
     * once with one that is. The second call is what makes the first mean
     * something: a `400` the route would have answered anyway, for a field
     * this test never set, would otherwise read as the refusal.
     */
    const refuses = (
      label: string,
      send: (
        metadata: unknown
      ) => Promise<{ status: number; body: { error?: { code?: string } } }>
    ) => {
      test(label, async () => {
        const refused = await send(NOT_A_BAG);

        expect(refused.status).toBe(400);
        expect(refused.body.error?.code).toBe('VALIDATION_FAILED');

        const accepted = await send({ team: 'payments' });
        expect(accepted.status).toBeLessThan(300);
      });
    };

    refuses('POST /api/v1/documents', async (metadata) => {
      return client()
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'x',
          filename: `refused-${String(metadata)}.txt`,
          metadata,
        });
    });

    refuses('PATCH /api/v1/documents/:document_id', async (metadata) => {
      return client()
        .patch(`/api/v1/documents/${documentId}`)
        .send({ content: 'y', metadata });
    });

    refuses(
      'POST /api/v1/conversations/:conversation_id/messages',
      async (metadata) => {
        return client()
          .post(`/api/v1/conversations/${conversationId}/messages`)
          .send({ role: 'user', message: 'hi', metadata });
      }
    );

    refuses('POST /api/v1/ingestion-rules', async (metadata) => {
      return client()
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob:
            typeof metadata === 'string'
              ? 'application/json'
              : 'application/xml',
          tool_id: toolId,
          action: 'list-tools',
          metadata,
        });
    });

    refuses(
      'PATCH /api/v1/ingestion-rules/:ingestion_rule_id',
      async (metadata) => {
        return client()
          .patch(`/api/v1/ingestion-rules/${ingestionRuleId}`)
          .send({ metadata });
      }
    );

    refuses('POST /api/v1/formations', async (metadata) => {
      return client()
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `refused-formation-${String(metadata).replace(/\W/g, '')}`,
          template: { resources: {} },
          metadata,
        });
    });

    refuses('PUT /api/v1/formations/:formation_id', async (metadata) => {
      return client()
        .put(`/api/v1/formations/${formationId}`)
        .send({ template: { resources: {} }, metadata });
    });
  });

  describe('a bag that is read rather than stored', () => {
    test('the metadata-schema validator judges it instead of refusing it', async () => {
      // This endpoint's answer *is* a verdict on a bag, so it reports one
      // rather than refusing the request. What the verdict says depends on the
      // schemas governing the path, which `metadataSchemas.test.ts` covers.
      const response = await client()
        .post('/api/v1/metadata-schemas/validate')
        .send({
          project_id: projectId,
          path: '/reports/q1.md',
          metadata: NOT_A_BAG,
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBeDefined();
    });
  });
});
