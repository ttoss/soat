import { setupProjectWithUsers } from '../../fixtures/bootstrap';

describe('setupProjectWithUsers fixture', () => {
  test('rejects when the server refuses the policy', async () => {
    await expect(
      setupProjectWithUsers({
        prefix: 'fixturebadpolicy',
        policyActions: ['nosuchmodule:NoSuchAction'],
        createNoPermUser: false,
      })
    ).rejects.toThrow(/policy 400/);
  });

  test('policyActions: [] creates no policy', async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fixturenopolicy',
      policyActions: [],
      createNoPermUser: false,
    });
    expect(setup.policyId).toBeUndefined();
  });
});
