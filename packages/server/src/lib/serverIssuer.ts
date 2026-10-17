/**
 * The URL this deployment names itself by: the OAuth issuer and the `iss` of
 * every tool assertion. A leaf, so both can read it without importing each
 * other.
 */
const PORT = process.env.PORT ?? '5047';

export const ISSUER = process.env.SOAT_BASE_URL ?? `http://localhost:${PORT}`;
