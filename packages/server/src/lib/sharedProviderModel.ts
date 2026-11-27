import type { LanguageModelMiddleware } from 'ai';
import { APICallError } from 'ai';
import createDebug from 'debug';

import { loggableError } from './loggableError';
import { isFetchFailure } from './providerError';
import { withheldVendorFault } from './replayRefusal';
import { admitSharedCall } from './shareCaps';

const log = createDebug('soat:shares');

const SHARED_FAILURE = 'The shared AI provider failed to answer.';

const sharedFailure = (args: { error: unknown; isRetryable: boolean }) => {
  return withheldVendorFault({
    error: args.error,
    message: SHARED_FAILURE,
    shared: true,
    isRetryable: args.isRetryable,
  });
};

/**
 * The vendor's status and body belong to the publisher, whose credential and
 * endpoint they describe: the grantee gets a retryable-or-not failure and the
 * refusal's classified cause only, and the detail goes to the runtime's error
 * log.
 */
const withheld = (args: {
  error: unknown;
  providerPublicId: string;
}): unknown => {
  const fromVendor =
    APICallError.isInstance(args.error) || isFetchFailure(args.error);
  if (!fromVendor) return args.error;
  // eslint-disable-next-line no-console
  console.error(
    `shared AI provider ${args.providerPublicId} failed:`,
    loggableError(args.error)
  );
  return sharedFailure({
    error: args.error,
    isRetryable: APICallError.isInstance(args.error)
      ? args.error.isRetryable
      : true,
  });
};

/**
 * A model built from a provider another project shares with `grantee`: each
 * call counts against the share's cap before it leaves, and a vendor failure
 * reaches the grantee without the vendor's detail.
 */
export const throughShare = (args: {
  providerPublicId: string;
  grantee: number;
}): LanguageModelMiddleware => {
  const admit = async () => {
    log(
      'throughShare: provider=%s grantee=%d',
      args.providerPublicId,
      args.grantee
    );
    await admitSharedCall({
      resourceType: 'aiProvider',
      resourceId: args.providerPublicId,
      projectId: args.grantee,
    });
  };
  const hide = (error: unknown): unknown => {
    return withheld({ error, providerPublicId: args.providerPublicId });
  };

  return {
    wrapGenerate: async ({ doGenerate }) => {
      await admit();
      try {
        return await doGenerate();
      } catch (error) {
        throw hide(error);
      }
    },
    wrapStream: async ({ doStream }) => {
      await admit();
      let streamed: Awaited<ReturnType<typeof doStream>>;
      try {
        streamed = await doStream();
      } catch (error) {
        throw hide(error);
      }
      return {
        ...streamed,
        stream: streamed.stream.pipeThrough(
          new TransformStream({
            transform: (part, controller) => {
              if (part.type !== 'error') {
                controller.enqueue(part);
                return;
              }
              // eslint-disable-next-line no-console
              console.error(
                `shared AI provider ${args.providerPublicId} streamed an error:`,
                loggableError(part.error)
              );
              controller.enqueue({
                ...part,
                error: sharedFailure({
                  error: part.error,
                  isRetryable: false,
                }),
              });
            },
          })
        ),
      };
    },
  };
};
