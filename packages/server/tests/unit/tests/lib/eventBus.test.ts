import { emitEvent, onEvent, resolveProjectPublicId } from 'src/lib/eventBus';

describe('resolveProjectPublicId', () => {
  test('returns empty string when project does not exist', async () => {
    const result = await resolveProjectPublicId({ projectId: 999999999 });
    expect(result).toBe('');
  });
});

describe('emitEvent / onEvent', () => {
  test('emitted events are received by registered listener', () => {
    const handler = jest.fn();
    onEvent(handler);

    emitEvent({
      type: 'test.created',
      projectId: 1,
      projectPublicId: 'proj_test',
      resourceType: 'test',
      resourceId: 'res_1',
      data: { key: 'value' },
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'test.created',
        projectPublicId: 'proj_test',
      })
    );
  });
});
