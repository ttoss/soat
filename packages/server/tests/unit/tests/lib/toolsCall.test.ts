import { callEphemeralTool } from 'src/lib/toolsCall';

// `callEphemeralTool` executes an inline tool definition (no persisted Tool
// row) directly — used by pipeline steps and agents' inline `tools`. No
// existing test exercises this entry point directly.
describe('callEphemeralTool', () => {
  test('rejects a client-type definition — client tools cannot run server-side', async () => {
    await expect(
      callEphemeralTool({
        definition: { name: 'inline-client-tool', type: 'client' },
        projectId: 1,
      })
    ).rejects.toThrow(
      'Client tools cannot be invoked server-side; they must be executed by the calling client.'
    );
  });
});
