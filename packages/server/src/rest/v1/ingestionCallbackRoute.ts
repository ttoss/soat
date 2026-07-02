import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { completeIngestionCallback } from 'src/lib/documents';

/**
 * The HTTP transport constrains the converter output contract slightly: the
 * request body must be a JSON object (a bare top-level JSON string is
 * rejected by the body parser), so a single page is sent as `{ text }`
 * instead of a raw string. `{ pages: [...] }` is unchanged.
 */
const normalizeIngestionCallbackOutput = (body: unknown): unknown => {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'text' in body &&
    !('pages' in body)
  ) {
    return (body as { text: unknown }).text;
  }
  return body;
};

/**
 * Token-authed callback for an async converter — not IAM-gated, since the
 * external converter is not a SOAT principal (see ingestionCallbackToken.ts).
 * Split out of documents.ts to keep that file under the line-count limit.
 */
export const registerIngestionCallbackRoute = (args: {
  documentsRouter: Router<Context>;
}) => {
  args.documentsRouter.post(
    '/documents/:document_id/ingestion-callback',
    async (ctx: Context) => {
      const token = ctx.query.token as string | undefined;
      if (!token) {
        throw new DomainError(
          'INGESTION_CALLBACK_INVALID_TOKEN',
          'A `token` query parameter is required.'
        );
      }

      await completeIngestionCallback({
        documentId: ctx.params.document_id,
        token,
        output: normalizeIngestionCallbackOutput(ctx.request.body),
      });

      ctx.status = 204;
    }
  );
};
