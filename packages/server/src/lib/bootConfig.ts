import { initDeploymentRegistrations } from './deploymentRegistrations';
import {
  EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV,
  embeddingPriceWarning,
  readEmbeddingInputTokenPriceUsd,
} from './embeddingPrice';
import { headerPrefix } from './headerPrefix';
import { loggableError } from './loggableError';
import { readSecretsEncryptionKey } from './secretsEncryptionKey';
import { reservedToolContextPrefix } from './toolContext';
import { readUploadUrlTemplate } from './uploadUrlTemplate';

/**
 * Loads the deployment's registrations and reads every setting that is
 * validated when read, so a malformed value fails boot instead of each call
 * that reads it. Throws on the first one that does not parse.
 */
export const loadBootConfig = (): void => {
  initDeploymentRegistrations();
  readEmbeddingInputTokenPriceUsd();
  headerPrefix();
  reservedToolContextPrefix();
  readSecretsEncryptionKey();
  readUploadUrlTemplate();
};

/**
 * Every process entrypoint's first step: `loadBootConfig`, exiting on a
 * malformed setting before the database is touched.
 */
export const loadBootConfigOrExit = (): void => {
  try {
    loadBootConfig();
  } catch (error) {
    // Fatal and process-terminating, so it goes to stderr unconditionally
    // rather than through the opt-in `debug` logger.
    // eslint-disable-next-line no-console
    console.error(loggableError(error));
    process.exit(1);
  }

  const priceWarning = embeddingPriceWarning({
    provider: process.env.EMBEDDING_PROVIDER,
    value: process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV],
  });
  if (priceWarning) {
    // Unconditional: the one boot where an unintended zero is still cheap to
    // fix is this one.
    // eslint-disable-next-line no-console
    console.warn(priceWarning);
  }
};
