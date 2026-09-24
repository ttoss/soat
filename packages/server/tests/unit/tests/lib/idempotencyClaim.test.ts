import { claimIdempotencyKey } from 'src/lib/idempotencyClaim';

const uniqueViolation = () => {
  return Object.assign(new Error('duplicate key'), {
    name: 'SequelizeUniqueConstraintError',
  });
};

// Only the rethrows: no entry point can make the insert fail for another reason
// or lose a race to a row it cannot read back.
describe('claimIdempotencyKey', () => {
  test('rethrows a unique violation whose winner cannot be read back', async () => {
    const violation = uniqueViolation();

    await expect(
      claimIdempotencyKey({
        replay: async () => {
          return null;
        },
        create: async () => {
          throw violation;
        },
      })
    ).rejects.toBe(violation);
  });

  test('rethrows any other failure without a second lookup', async () => {
    const failure = new Error('connection lost');
    const replay = jest
      .fn<Promise<string | null>, []>()
      .mockResolvedValue(null);

    await expect(
      claimIdempotencyKey({
        replay,
        create: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(replay).toHaveBeenCalledTimes(1);
  });
});
