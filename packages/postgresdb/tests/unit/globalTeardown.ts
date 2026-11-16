const globalTeardown = async () => {
  await globalThis.soatPostgresdbTestContainer?.stop();
  globalThis.soatPostgresdbTestContainer = undefined;
};

export default globalTeardown;
