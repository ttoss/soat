const ENV = 'SECRETS_ENCRYPTION_KEY';

/**
 * The AES-256 key every stored secret is encrypted under. Read per call;
 * `loadBootConfig` reads it at boot, so an unset or malformed key stops the
 * process before any secret is written or read.
 */
export const readSecretsEncryptionKey = (): Buffer => {
  const key = process.env[ENV];
  if (!key) {
    throw new Error(`${ENV} environment variable is not set`);
  }
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32 || buf.toString('hex') !== key.toLowerCase()) {
    throw new Error(`${ENV} must be a 64-character hex string (32 bytes)`);
  }
  return buf;
};
