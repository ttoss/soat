/**
 * Base URL of the documentation site error responses and MCP docs tools link
 * to. Overridable via `SOAT_DOCS_BASE_URL` for a self-hosted deployment that
 * publishes its own docs, or fronts this API and does not want to name SOAT on
 * a public surface (ttoss/soat#1126).
 *
 * A function, not a constant: `docsUrlFor` and `DEFAULT_RESOLUTION` read it at
 * call time, so a deployment that sets the env var — or a test that sets it
 * per-case — is not stuck with whatever value existed at import time.
 */
export const docsBaseUrl = (): string => {
  return process.env.SOAT_DOCS_BASE_URL ?? 'https://soat.ttoss.dev';
};
