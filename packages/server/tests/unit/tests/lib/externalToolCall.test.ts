/**
 * `SOAT_TOOL_CALL_TIMEOUT_MS` is read once, at module load, so neither arm of
 * its default is reachable through an entry point — the process that serves the
 * tests already resolved it. Re-evaluating the module under an isolated
 * registry is the only way to exercise the override, and it pins real
 * configuration behaviour that nothing else covers.
 */
const loadTimeout = (envValue: string | undefined): number => {
  const previous = process.env.SOAT_TOOL_CALL_TIMEOUT_MS;
  if (envValue === undefined) {
    delete process.env.SOAT_TOOL_CALL_TIMEOUT_MS;
  } else {
    process.env.SOAT_TOOL_CALL_TIMEOUT_MS = envValue;
  }

  let loaded = 0;
  try {
    jest.isolateModules(() => {
      loaded = jest.requireActual<{ SOAT_TOOL_CALL_TIMEOUT_MS: number }>(
        'src/lib/externalToolCall'
      ).SOAT_TOOL_CALL_TIMEOUT_MS;
    });
  } finally {
    if (previous === undefined) {
      delete process.env.SOAT_TOOL_CALL_TIMEOUT_MS;
    } else {
      process.env.SOAT_TOOL_CALL_TIMEOUT_MS = previous;
    }
  }
  return loaded;
};

describe('SOAT_TOOL_CALL_TIMEOUT_MS', () => {
  test('defaults to five minutes when the deployment sets nothing', () => {
    expect(loadTimeout(undefined)).toBe(300_000);
  });

  test('takes the deployment value when one is set', () => {
    expect(loadTimeout('1500')).toBe(1500);
  });
});
