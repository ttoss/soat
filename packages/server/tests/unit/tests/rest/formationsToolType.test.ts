import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A template tool's `type` takes the values `POST /tools` takes: a literal
 * outside them is refused before the apply, an expression waits for it.
 */
describe('Formations: a tool resource type', () => {
  let userToken: string;
  let projectId: string;

  const toolTemplate = (type: unknown) => {
    return {
      parameters: { ToolType: { type: 'string', default: 'http' } },
      resources: {
        Bad: {
          type: 'tool',
          properties: {
            name: 'formation-tool-type',
            type,
            execute: { url: 'https://example.com/hook' },
          },
        },
      },
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fmtooltype',
      policyActions: ['formations:CreateFormation', 'tools:CreateTool'],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('POST /api/v1/formations/validate', () => {
    test('reports an unsupported literal type on `type`', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: toolTemplate('naturali') });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual([
        expect.objectContaining({ path: 'resources.Bad.properties.type' }),
      ]);
    });

    test('leaves a `param` type to the apply', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: toolTemplate({ param: 'ToolType' }) });
      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
    });
  });

  describe('POST /api/v1/formations', () => {
    test('refuses an unsupported literal type', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'formation-tool-type-literal',
          template: toolTemplate('naturali'),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.details).toEqual([
        expect.objectContaining({ path: 'resources.Bad.properties.type' }),
      ]);
    });

    test('fails the apply when a parameter resolves to an unsupported type', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'formation-tool-type-param',
          template: toolTemplate({ param: 'ToolType' }),
          parameters: { ToolType: 'naturali' },
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
    });
  });
});
