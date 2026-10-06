import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const LARGE = 'x'.repeat(2 * 1024 * 1024);

describe('formation request body limit', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fbody',
      policyActions: [
        'formations:ValidateFormation',
        'memories:CreateMemoryStore',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  test('a template over 1 MB is accepted', async () => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/formations/validate')
      .send({
        template: {
          resources: {
            Doc: {
              type: 'document',
              properties: { path: '/big.md', content: LARGE },
            },
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
  });

  test('other routes keep the default limit', async () => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'big', description: LARGE });

    expect(response.status).toBe(413);
  });
});
